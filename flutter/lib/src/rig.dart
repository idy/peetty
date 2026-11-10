import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'dart:ui' show Canvas, Color, Offset, Paint, PaintingStyle, Path, Rect, BlendMode;

import 'figure.dart';
import 'motion.dart';

/// Draws a rig figure on a canvas and moves it from a [Pose] each frame.
/// Ported from the web SDK (`src/figure/rig.ts`).
const _springStep = 1 / 120;
const _soulRadius = 22.0;
const _soulRise = Offset(58, -96);
const _soulMouth = 9.0;

/// Fallback order when a figure does not draw a requested slot state.
const _slotFallbacks = <String, List<String>>{
  'eyes:closed': ['eyes:open'],
  'eyes:happy': ['eyes:closed', 'eyes:open'],
  'eyes:sleepy': ['eyes:closed', 'eyes:open'],
  'mouth:open': ['mouth:smile'],
  'mouth:talk': ['mouth:open', 'mouth:smile'],
  'mouth:o': ['mouth:open', 'mouth:smile'],
  'mouth:flat': ['mouth:smile'],
  'brows:worried': ['brows:calm'],
  'hand:book': ['hand:rest'],
  'hand:cup': ['hand:rest'],
  'hand:camera': ['hand:rest'],
  'hand:umbrella': ['hand:rest'],
  'mouth:gum': ['mouth:o', 'mouth:smile'],
  'mouth:gumBig': ['mouth:gum', 'mouth:o', 'mouth:smile'],
};

double _clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);

/// A 2D affine transform `[a b c d e f]`, as in SVG `matrix()`.
class Affine {
  const Affine(this.a, this.b, this.c, this.d, this.e, this.f);
  static const identity = Affine(1, 0, 0, 1, 0, 0);
  final double a, b, c, d, e, f;

  Affine operator *(Affine n) => Affine(
        a * n.a + c * n.b,
        b * n.a + d * n.b,
        a * n.c + c * n.d,
        b * n.c + d * n.d,
        a * n.e + c * n.f + e,
        b * n.e + d * n.f + f,
      );

  Offset apply(Offset p) => Offset(a * p.dx + c * p.dy + e, b * p.dx + d * p.dy + f);

  /// Column-major 4x4 matrix for [Canvas.transform].
  Float64List get storage => Float64List.fromList([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1]);

  /// The inverse, or null when the transform is degenerate.
  Affine? get inverse {
    final det = a * d - b * c;
    if (det == 0) return null;
    return Affine(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det);
  }
}

class _PartView {
  _PartView(this.part);
  final FigurePart part;
  bool visible = true;
  double angle = 0;
  double velocity = 0;
  Offset? last;
  Offset lastVelocity = Offset.zero;
  Offset pendingAcceleration = Offset.zero;
}

class Rig {
  Rig(this.figure, {Map<String, String> palette = const {}})
      : unit = figure.unit,
        _palette = {...figure.palette} {
    for (final MapEntry(:key, :value) in palette.entries) {
      if (_palette.containsKey(key) && parseColor(value) != null) _palette[key] = value;
    }
    for (final part in figure.parts) {
      if (part.slot != null) _available.add(part.slot!);
      _views.add(_PartView(part));
    }
    for (final MapEntry(:key, :value) in figure.gradients.entries) {
      _shaders[key] = _shader(value);
    }
    final head = figure.skeleton[Bone.head]!;
    _mouth = Offset(head.dx, head.dy - _soulMouth * unit);
    for (final MapEntry(:key, :value) in slotStates.entries) {
      _slots[key] = value.first;
    }
    _refreshSlots();
    frame(const {}, 0);
  }

  final Figure figure;

  /// Drawing units per animation unit.
  final double unit;
  final Map<String, String> _palette;
  final _views = <_PartView>[];
  final _available = <String>{};
  final _slots = <String, String>{};
  final _shaders = <String, ui.Shader>{};
  late final Offset _mouth;
  Offset _look = Offset.zero;
  Map<Bone, Affine> _world = {};
  double _springRemainder = 0;
  Soul? _soul;

  /// Switches several slots at once, falling back to drawn states when needed.
  void setSlots(Map<String, String> slots) {
    var changed = false;
    for (final MapEntry(:key, :value) in slots.entries) {
      if (_slots[key] == value) continue;
      _slots[key] = value;
      changed = true;
    }
    if (changed) _refreshSlots();
  }

  /// Pointer direction for the eyes, each axis -1..1.
  void setLook(double x, double y) => _look = Offset(_clamp(x, -1, 1), _clamp(y, -1, 1));

  /// Her soul after a fright, or null. While it is out the irises go blank.
  void setSoul(Soul? soul) {
    final changed = (soul == null) != (_soul == null);
    _soul = soul;
    if (changed) _refreshSlots();
  }

  /// Applies a pose and advances springs.
  /// [push] is whole-figure acceleration in viewBox units/s².
  void frame(Pose pose, double dt, [Offset push = Offset.zero]) {
    _world = _worldMatrices(pose);
    final step = math.min(math.max(dt, 0.0), 0.1);
    final elapsed = _springRemainder + step;
    final steps = ((elapsed + 1e-10) / _springStep).floor();
    for (final view in _views) {
      final part = view.part;
      // Hidden alternatives still track their bone and spring.
      if (part.spring != null && part.pivot != null) _spring(view, _world[part.bone]!, step, push, steps);
    }
    _springRemainder = math.max(0, elapsed - steps * _springStep);
  }

  /// Paints the figure in viewBox coordinates.
  void paint(Canvas canvas) {
    // Isolate blending to the figure, like `isolation: isolate` on the web.
    canvas.saveLayer(null, Paint());
    for (final view in _views) {
      if (!view.visible) continue;
      final part = view.part;
      canvas.save();
      canvas.transform(_world[part.bone]!.storage);
      if (part.clip != null) canvas.clipPath(figure.clips[part.clip]!);
      if (part.look != null) canvas.translate(_look.dx * part.look!.dx, _look.dy * part.look!.dy);
      if (part.spring != null && part.pivot != null && view.angle != 0) {
        final p = part.pivot!;
        canvas.translate(p.dx, p.dy);
        canvas.rotate(view.angle * math.pi / 180);
        canvas.translate(-p.dx, -p.dy);
      }
      for (final shape in part.shapes) {
        _drawShape(canvas, shape);
      }
      canvas.restore();
    }
    if (_soul != null) _drawSoul(canvas, _soul!);
    canvas.restore();
  }

  /// Whether a point in viewBox coordinates lands on a drawn part.
  bool hitTest(Offset point) {
    for (final view in _views.reversed) {
      if (!view.visible) continue;
      final inverse = _world[view.part.bone]!.inverse;
      if (inverse == null) continue;
      final local = inverse.apply(point);
      for (final shape in view.part.shapes) {
        if ((shape.fill != null || shape.stroke != null) && shape.path.getBounds().inflate(shape.strokeWidth).contains(local) && shape.path.contains(local)) {
          return true;
        }
      }
    }
    return false;
  }

  void _drawShape(Canvas canvas, FigureShape shape) {
    final fill = _paint(shape.fill);
    final stroke = _paint(shape.stroke);
    if (fill == null && stroke == null) return;
    final opacity = shape.opacity ?? 1;
    // SVG opacity and blending apply to fill and stroke together.
    final layered = opacity < 1 || (shape.blend != BlendMode.srcOver && fill != null && stroke != null);
    if (layered) {
      canvas.saveLayer(null, Paint()
        ..color = Color.from(alpha: _clamp(opacity, 0, 1), red: 0, green: 0, blue: 0)
        ..blendMode = shape.blend);
    }
    final blend = layered ? BlendMode.srcOver : shape.blend;
    if (fill != null) canvas.drawPath(shape.path, fill..blendMode = blend);
    if (stroke != null) {
      canvas.drawPath(
        shape.path,
        stroke
          ..style = PaintingStyle.stroke
          ..strokeWidth = shape.strokeWidth
          ..strokeCap = shape.lineCap
          ..strokeJoin = shape.lineJoin
          ..blendMode = blend,
      );
    }
    if (layered) canvas.restore();
  }

  /// One outline: a round wisp floating up beside her head, its tail curling into her mouth.
  void _drawSoul(Canvas canvas, Soul soul) {
    final u = unit;
    final m = _world[Bone.head]!.apply(_mouth);
    final r = _soulRadius * u * (0.35 + 0.65 * soul.out);
    final dx = soul.drift.dx * u, dy = soul.drift.dy * u;
    final cx = m.dx + (_soulRise.dx * u + dx) * soul.out;
    final cy = m.dy + (_soulRise.dy * u + dy) * soul.out;
    final kx = cx + dx * 0.8;
    final ky = m.dy;
    final toward = math.atan2(ky - cy, kx - cx);
    final nx = -math.sin(toward), ny = math.cos(toward);
    Offset edge(double side) => Offset(cx + r * math.cos(toward + side), cy + r * math.sin(toward + side));
    final a = edge(0.85);
    final b = edge(-0.85);
    final wide = r * 0.4;
    final path = Path()
      ..moveTo(b.dx, b.dy)
      ..arcToPoint(a, radius: ui.Radius.circular(r), largeArc: true, clockwise: false)
      ..quadraticBezierTo(kx + nx * wide, ky + ny * wide, m.dx, m.dy)
      ..quadraticBezierTo(kx - nx * wide, ky - ny * wide, b.dx, b.dy)
      ..close();
    canvas.saveLayer(null, Paint()..color = Color.from(alpha: math.min(1, soul.out * 3), red: 0, green: 0, blue: 0));
    canvas.drawPath(path, Paint()..color = const Color(0xffffffff));
    canvas.drawPath(
      path,
      Paint()
        ..color = const Color(0xffbdb6e0)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2 * u
        ..strokeJoin = ui.StrokeJoin.round,
    );
    final face = Paint()..color = const Color(0xff5f5a80);
    for (final (fx, fy, rx, ry) in const [(-0.34, -0.12, 0.12, 0.15), (0.34, -0.12, 0.12, 0.15), (0.0, 0.3, 0.12, 0.16)]) {
      canvas.drawOval(Rect.fromCenter(center: Offset(cx + fx * r, cy + fy * r), width: rx * r * 2, height: ry * r * 2), face);
    }
    canvas.restore();
  }

  void _spring(_PartView view, Affine matrix, double dt, Offset push, int steps) {
    final spring = view.part.spring!;
    final position = matrix.apply(view.part.pivot!);
    if (view.last == null || dt == 0) {
      view.last = position;
      return;
    }
    final velocity = (position - view.last!) / dt;
    // Motion uses the drawing's units; spring tuning uses a 260-unit figure.
    final ax = ((velocity.dx - view.lastVelocity.dx) / dt + push.dx) / unit;
    final ay = ((velocity.dy - view.lastVelocity.dy) / dt + push.dy) / unit;
    view.last = position;
    view.lastVelocity = velocity;

    if (steps == 0) {
      view.pendingAcceleration += Offset(ax * dt, ay * dt);
      return;
    }
    final gain = spring.gain ?? 1;
    final limit = spring.limit ?? 25;
    final boneAngle = math.atan2(matrix.b, matrix.a) * 180 / math.pi;
    final target = -boneAngle * (spring.hang ?? 0.6);
    // Carry partial ticks and their acceleration across display frames.
    final firstDuration = _springStep - _springRemainder;
    for (var i = 0; i < steps; i++) {
      final tickAx = i == 0 ? (view.pendingAcceleration.dx + ax * firstDuration) / _springStep : ax;
      final tickAy = i == 0 ? (view.pendingAcceleration.dy + ay * firstDuration) / _springStep : ay;
      final sign = view.angle == 0 ? 1.0 : view.angle.sign;
      final force = _clamp((-tickAx * 0.0009 - tickAy.abs() * 0.00015 * sign) * gain, -4, 4) * 0.5;
      view.velocity += (target - view.angle) * spring.stiffness * 0.5 + force;
      view.velocity *= spring.damping;
      view.angle = _clamp(view.angle + view.velocity, -limit, limit);
    }
    final remainder = math.max(0.0, _springRemainder + dt - steps * _springStep);
    view.pendingAcceleration = Offset(ax * remainder, ay * remainder);
  }

  Map<Bone, Affine> _worldMatrices(Pose pose) {
    final out = <Bone, Affine>{};
    for (final bone in Bone.values) {
      final pivot = figure.skeleton[bone]!;
      final p = pose[bone];
      final r = (p?.rotate ?? 0) * math.pi / 180;
      final sx = p?.sx ?? 1, sy = p?.sy ?? 1;
      final cos = math.cos(r), sin = math.sin(r);
      // translate(pivot + offset) · rotate · scale · translate(-pivot)
      final a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
      final px = pivot.dx, py = pivot.dy;
      final local = Affine(a, b, c, d, px + (p?.x ?? 0) - (a * px + c * py), py + (p?.y ?? 0) - (b * px + d * py));
      final parent = boneParents[bone];
      out[bone] = parent == null ? local : out[parent]! * local;
    }
    return out;
  }

  void _refreshSlots() {
    final shown = <String>{};
    for (final MapEntry(key: slot, value: state) in _slots.entries) {
      final wanted = '$slot:$state';
      final fallback = '$slot:${slotStates[slot]!.first}';
      for (final candidate in [wanted, ...?_slotFallbacks[wanted], fallback]) {
        if (_available.contains(candidate)) {
          shown.add(candidate);
          break;
        }
      }
    }
    for (final view in _views) {
      final part = view.part;
      if (part.slot == null && part.look == null) continue;
      // Irises are the parts that follow the pointer; with her soul out, her eyes go blank.
      view.visible = (part.slot == null || shown.contains(part.slot)) && !(_soul != null && part.look != null);
    }
  }

  String _color(String value) => _palette[value] ?? value;

  Paint? _paint(String? value) {
    if (value == null) return null;
    if (_shaders[value] case final shader?) return Paint()..shader = shader;
    if (value == 'none') return null;
    final color = parseColor(_color(value));
    return color == null ? null : (Paint()..color = color);
  }

  ui.Shader _shader(FigureGradient g) {
    final colors = <Color>[];
    final stops = <double>[];
    for (final stop in g.stops) {
      final color = parseColor(_color(stop.color)) ?? const Color(0x00000000);
      colors.add(color.withValues(alpha: color.a * (stop.opacity ?? 1)));
      stops.add(_clamp(stop.offset, 0, 1));
    }
    if (colors.length == 1) {
      colors.add(colors.first);
      stops.add(1);
    }
    return switch (g) {
      LinearFigureGradient(:final from, :final to) => ui.Gradient.linear(from, to, colors, stops),
      RadialFigureGradient(:final center, :final radius, :final focus) =>
        ui.Gradient.radial(center, radius, colors, stops, ui.TileMode.clamp, null, focus, 0),
    };
  }
}
