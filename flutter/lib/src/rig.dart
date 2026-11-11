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

/// The canvas default, and SVG's: sharper miter joins are drawn beveled.
const _miterLimit = 4.0;

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
      // The clip sits outside the look/spring transform, so an iris can move inside its eye.
      if (_inner(view) case final inner?) canvas.transform(inner.storage);
      for (final shape in part.shapes) {
        _drawShape(canvas, shape);
      }
      canvas.restore();
    }
    if (_soul != null) _drawSoul(canvas, _soul!);
    canvas.restore();
  }

  /// The look and spring transform inside a part's clip, or null when it has none.
  Affine? _inner(_PartView view) {
    final part = view.part;
    var m = Affine.identity;
    var moved = false;
    if (part.look != null) {
      m = Affine(1, 0, 0, 1, _look.dx * part.look!.dx, _look.dy * part.look!.dy);
      moved = true;
    }
    if (part.spring != null && part.pivot != null && view.angle != 0) {
      final p = part.pivot!;
      final r = view.angle * math.pi / 180;
      final cos = math.cos(r), sin = math.sin(r);
      // rotate(angle) around the pivot.
      m = m * Affine(cos, sin, -sin, cos, p.dx - cos * p.dx + sin * p.dy, p.dy - sin * p.dx - cos * p.dy);
      moved = true;
    }
    return moved ? m : null;
  }

  /// Whether a point in viewBox coordinates lands on painted fill or stroke,
  /// through the same bone, clip, look and spring transforms used to paint.
  bool hitTest(Offset point) {
    for (final view in _views.reversed) {
      if (!view.visible) continue;
      final part = view.part;
      final inverse = _world[part.bone]!.inverse;
      if (inverse == null) continue;
      final boneLocal = inverse.apply(point);
      if (part.clip != null && !figure.clips[part.clip]!.contains(boneLocal)) continue;
      final inner = _inner(view);
      final innerInverse = inner?.inverse;
      if (inner != null && innerInverse == null) continue;
      final local = innerInverse?.apply(boneLocal) ?? boneLocal;
      for (final shape in part.shapes) {
        if (_hitsShape(shape, local)) return true;
      }
    }
    return false;
  }

  bool _hitsShape(FigureShape shape, Offset local) {
    final fill = _paint(shape.fill);
    final stroke = _paint(shape.stroke);
    if (fill == null && stroke == null) return false;
    final half = stroke == null ? 0.0 : shape.strokeWidth / 2;
    // Miter joins reach up to the miter limit; square caps reach a corner.
    final reach = half * (shape.lineJoin == ui.StrokeJoin.miter ? _miterLimit : math.sqrt2);
    if (!shape.path.getBounds().inflate(reach + 0.5).contains(local)) return false;
    if (fill != null && shape.path.contains(local)) return true;
    return stroke != null && half > 0 && _onStroke(shape, local, half);
  }

  /// Whether [p] lies in the painted stroke: each segment's band, the caps at
  /// open ends and the joins between segments, as the canvas strokes them.
  static bool _onStroke(FigureShape shape, Offset p, double h) {
    for (final contour in shape.outline) {
      final points = _distinct(contour);
      final closed = contour.closed && points.length > 2;
      final n = points.length;
      if (n < 2) continue;
      final segments = closed ? n : n - 1;
      for (var i = 0; i < segments; i++) {
        final a = points[i], b = points[(i + 1) % n];
        final d = b - a;
        final length = d.distance;
        final u = d / length;
        final t = _dot(p - a, u);
        final square = !closed && shape.lineCap == ui.StrokeCap.square;
        final before = square && i == 0 ? h : 0.0;
        final after = square && i == segments - 1 ? h : 0.0;
        if (t >= -before && t <= length + after && _cross(u, p - a).abs() <= h) return true;
      }
      if (!closed && shape.lineCap == ui.StrokeCap.round) {
        if ((p - points.first).distance <= h || (p - points.last).distance <= h) return true;
      }
      for (var i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
        final previous = points[(i - 1 + n) % n], vertex = points[i], next = points[(i + 1) % n];
        if (_inJoin(shape.lineJoin, previous, vertex, next, p, h)) return true;
      }
    }
    return false;
  }

  /// Consecutive repeated points removed, including a closing point equal to the start.
  static List<Offset> _distinct(Contour contour) {
    final out = <Offset>[];
    for (final point in contour.points) {
      if (out.isEmpty || (point - out.last).distanceSquared > 1e-12) out.add(point);
    }
    if (contour.closed && out.length > 1 && (out.first - out.last).distanceSquared <= 1e-12) out.removeLast();
    return out;
  }

  static bool _inJoin(ui.StrokeJoin join, Offset previous, Offset vertex, Offset next, Offset p, double h) {
    if (join == ui.StrokeJoin.round) return (p - vertex).distance <= h;
    final d1 = (vertex - previous) / (vertex - previous).distance;
    final d2 = (next - vertex) / (next - vertex).distance;
    final turn = _cross(d1, d2);
    if (turn.abs() < 1e-9) return false;
    // The outer side of the corner, where the stroke needs filling in.
    final side = turn > 0 ? -1.0 : 1.0;
    final n1 = Offset(-d1.dy, d1.dx) * side, n2 = Offset(-d2.dy, d2.dx) * side;
    final a = vertex + n1 * h, b = vertex + n2 * h;
    if (join == ui.StrokeJoin.miter) {
      final bisector = n1 + n2;
      final cosHalf = _dot(bisector / bisector.distance, n1);
      if (cosHalf > 0 && 1 / cosHalf <= _miterLimit) {
        final tip = vertex + bisector / bisector.distance * (h / cosHalf);
        return _inConvex([vertex, a, tip, b], p);
      }
    }
    return _inConvex([vertex, a, b], p);
  }

  static bool _inConvex(List<Offset> polygon, Offset p) {
    var sign = 0.0;
    for (var i = 0; i < polygon.length; i++) {
      final c = _cross(polygon[(i + 1) % polygon.length] - polygon[i], p - polygon[i]);
      if (c.abs() < 1e-9) continue;
      if (sign == 0) {
        sign = c.sign;
      } else if (c.sign != sign) {
        return false;
      }
    }
    return sign != 0;
  }

  static double _dot(Offset a, Offset b) => a.dx * b.dx + a.dy * b.dy;
  static double _cross(Offset a, Offset b) => a.dx * b.dy - a.dy * b.dx;

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
