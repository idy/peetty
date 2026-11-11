import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui';

import 'package:path_parsing/path_parsing.dart';

/// Peetty figure pack, format version 1: the same JSON the web SDK reads.
///
/// A figure is data only: shapes, colors and motion hints. The animator owns
/// every movement, so a rig figure only attaches parts to the standard bones.
const figureFormat = 'peetty.figure';
const figureVersion = 1;

/// The SDK animates in the units of a figure 260 units tall.
const animationHeight = 260.0;

/// Standard skeleton, parents before children.
enum Bone { root, hips, body, head, armL, armR, legL, legR }

const Map<Bone, Bone?> boneParents = {
  Bone.root: null,
  Bone.hips: Bone.root,
  Bone.legL: Bone.hips,
  Bone.legR: Bone.hips,
  Bone.body: Bone.hips,
  Bone.head: Bone.body,
  Bone.armL: Bone.body,
  Bone.armR: Bone.body,
};

/// Slots switch between alternative parts; the first state is the default.
const Map<String, List<String>> slotStates = {
  'eyes': ['open', 'closed', 'happy', 'sleepy'],
  'mouth': ['smile', 'open', 'talk', 'flat', 'o', 'gum', 'gumBig'],
  'brows': ['calm', 'worried'],
  'hand': ['rest', 'book', 'cup', 'camera', 'umbrella'],
  'armL': ['rest', 'bent', 'up', 'fold'],
  'armR': ['rest', 'bent', 'up', 'fold'],
};

/// Animation states any figure can play.
enum FigureState { idle, walk, jump, fall, sit, lie, hang, sleep, drag, wave, talk, think }

/// States the companion may pick on her own; the others follow physics.
const autonomousActions = [
  FigureState.idle,
  FigureState.walk,
  FigureState.jump,
  FigureState.sit,
  FigureState.lie,
  FigureState.sleep,
  FigureState.think,
  FigureState.wave,
  FigureState.talk,
];

const heldProps = ['book', 'cup', 'camera'];

/// Size limits for untrusted figure data, matching the web validator's `LIMITS`.
const maxParts = 200;
const maxShapesPerPart = 64;
const maxPathLength = 20000;
const maxPaletteEntries = 64;
const maxGradients = 64;
const maxClips = 64;
const maxGradientStops = 16;
final _pathData = RegExp(r'^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$');

/// Thrown when figure data is not a valid rig figure.
class FigureFormatException extends FormatException {
  const FigureFormatException(super.message);
}

class GradientStop {
  const GradientStop(this.offset, this.color, this.opacity);
  final double offset;
  final String color;
  final double? opacity;
}

sealed class FigureGradient {
  const FigureGradient(this.stops);
  final List<GradientStop> stops;
}

class LinearFigureGradient extends FigureGradient {
  const LinearFigureGradient(this.from, this.to, super.stops);
  final Offset from;
  final Offset to;
}

class RadialFigureGradient extends FigureGradient {
  const RadialFigureGradient(this.center, this.radius, this.focus, super.stops);
  final Offset center;
  final double radius;
  final Offset? focus;
}

/// One drawn shape with its paint; the geometry is parsed once.
class FigureShape {
  FigureShape({
    required this.path,
    this.fill,
    this.stroke,
    this.strokeWidth = 1,
    this.opacity,
    this.lineCap = StrokeCap.round,
    this.lineJoin = StrokeJoin.round,
    this.blend = BlendMode.srcOver,
  });

  final Path path;
  final String? fill;
  final String? stroke;
  final double strokeWidth;
  final double? opacity;
  final StrokeCap lineCap;
  final StrokeJoin lineJoin;
  final BlendMode blend;
}

class FigureSpring {
  const FigureSpring({required this.stiffness, required this.damping, this.gain, this.limit, this.hang});
  final double stiffness;
  final double damping;
  final double? gain;
  final double? limit;
  final double? hang;
}

class FigurePart {
  const FigurePart({
    required this.id,
    required this.bone,
    required this.z,
    required this.shapes,
    this.slot,
    this.pivot,
    this.spring,
    this.look,
    this.clip,
  });

  final String id;
  final Bone bone;
  final double z;
  final String? slot;
  final Offset? pivot;
  final FigureSpring? spring;
  final Offset? look;
  final String? clip;
  final List<FigureShape> shapes;
}

class FigureBehavior {
  const FigureBehavior({
    this.weights = const {},
    this.walkSpeed = 1,
    this.jumpPower = 1,
    this.idleProp = 'none',
    this.fallProp = 'none',
  });

  final Map<FigureState, double> weights;
  final double walkSpeed;
  final double jumpPower;
  final String idleProp;
  final String fallProp;
}

/// A rig figure: a skeleton with parts drawn on its bones.
class Figure {
  Figure._({
    required this.id,
    required this.names,
    required this.viewBox,
    required this.height,
    required this.anchor,
    required this.palette,
    required this.behavior,
    required this.skeleton,
    required this.gradients,
    required this.clips,
    required this.parts,
  });

  final String id;

  /// Display names by language code; `''` holds a single unlocalized name.
  final Map<String, String> names;

  /// Drawing coordinates: left, top, width, height.
  final Rect viewBox;

  /// Display height in logical pixels at scale 1.
  final double height;

  /// The point that rests on an edge (feet), in viewBox coordinates.
  final Offset anchor;
  final Map<String, String> palette;
  final FigureBehavior behavior;
  final Map<Bone, Offset> skeleton;
  final Map<String, FigureGradient> gradients;
  final Map<String, Path> clips;

  /// Parts in draw order, back to front.
  final List<FigurePart> parts;

  /// Drawing units per animation unit.
  double get unit => viewBox.height / animationHeight;

  /// Display name for a language code such as `zh`, falling back to English.
  String name([String language = 'en']) =>
      names[language] ?? names['en'] ?? names[''] ?? (names.isEmpty ? 'Peetty' : names.values.first);

  /// Parses a figure from decoded JSON. Only rig figures are supported.
  factory Figure.fromJson(Object? json) {
    final f = _obj(json, 'figure');
    if (f['format'] != figureFormat) throw const FigureFormatException('format must be "peetty.figure"');
    if (f['version'] != figureVersion) throw const FigureFormatException('version must be 1');
    if (f['renderer'] != 'rig') throw const FigureFormatException('only rig figures are supported');

    final vb = _numbers(f['viewBox'], 'viewBox', 4);
    if (vb[2] <= 0 || vb[3] <= 0) throw const FigureFormatException('viewBox needs a positive size');
    final palette = <String, String>{};
    final paletteJson = _obj(f['palette'], 'palette');
    if (paletteJson.length > maxPaletteEntries) throw const FigureFormatException('palette has more than $maxPaletteEntries entries');
    for (final MapEntry(:key, :value) in paletteJson.entries) {
      if (value is! String || parseColor(value) == null) throw FigureFormatException('palette.$key must be a color');
      palette[key] = value;
    }

    final skeletonJson = _obj(f['skeleton'], 'skeleton');
    final skeleton = {
      for (final bone in Bone.values) bone: _point(_obj(skeletonJson[bone.name], 'skeleton.${bone.name}')['pivot'], 'skeleton.${bone.name}.pivot'),
    };

    final gradients = <String, FigureGradient>{};
    final gradientsJson = _obj(f['gradients'] ?? const {}, 'gradients');
    if (gradientsJson.length > maxGradients) throw const FigureFormatException('gradients has more than $maxGradients entries');
    for (final MapEntry(:key, :value) in gradientsJson.entries) {
      gradients[key] = _gradient(_obj(value, 'gradients.$key'), 'gradients.$key');
    }

    final clips = <String, Path>{};
    final clipsJson = _obj(f['clips'] ?? const {}, 'clips');
    if (clipsJson.length > maxClips) throw const FigureFormatException('clips has more than $maxClips entries');
    for (final MapEntry(:key, :value) in clipsJson.entries) {
      // A geometric union, as an SVG clipPath combines its children; appending
      // contours to one nonzero path would cancel overlaps of opposite winding.
      Path? union;
      for (final shape in _shapeList(value, 'clips.$key')) {
        final path = _geometry(_obj(shape, 'clips.$key[]'), 'clips.$key');
        union = union == null ? path : Path.combine(PathOperation.union, union, path);
      }
      clips[key] = union!;
    }

    final parts = <FigurePart>[];
    final partsJson = _list(f['parts'], 'parts');
    if (partsJson.isEmpty || partsJson.length > maxParts) throw const FigureFormatException('parts needs 1–$maxParts parts');
    for (var i = 0; i < partsJson.length; i++) {
      parts.add(_part(_obj(partsJson[i], 'parts[$i]'), 'parts[$i]', clips));
    }
    // Stable sort by z, like Array.prototype.sort.
    final indexed = [for (var i = 0; i < parts.length; i++) (i, parts[i])]
      ..sort((a, b) {
        final byZ = a.$2.z.compareTo(b.$2.z);
        return byZ != 0 ? byZ : a.$1.compareTo(b.$1);
      });

    return Figure._(
      id: _string(f['id'], 'id'),
      names: _localized(f['name'], 'name'),
      viewBox: Rect.fromLTWH(vb[0], vb[1], vb[2], vb[3]),
      height: _positive(f['height'], 'height'),
      anchor: _point(f['anchor'], 'anchor'),
      palette: palette,
      behavior: _behavior(f['behavior']),
      skeleton: skeleton,
      gradients: gradients,
      clips: clips,
      parts: [for (final (_, part) in indexed) part],
    );
  }
}

FigurePart _part(Map<String, Object?> p, String at, Map<String, Path> clips) {
  final boneName = _string(p['bone'], '$at.bone');
  final bone = Bone.values.where((b) => b.name == boneName).firstOrNull;
  if (bone == null) throw FigureFormatException('$at.bone is not a standard bone');
  final clip = _optionalString(p['clip'], '$at.clip');
  if (clip != null && !clips.containsKey(clip)) throw FigureFormatException('$at.clip is not defined');
  final spring = p['spring'] == null ? null : _obj(p['spring'], '$at.spring');
  return FigurePart(
    id: _string(p['id'], '$at.id'),
    bone: bone,
    z: _number(p['z'], '$at.z'),
    slot: _optionalString(p['slot'], '$at.slot'),
    pivot: p['pivot'] == null ? null : _point(p['pivot'], '$at.pivot'),
    look: p['look'] == null ? null : _point(p['look'], '$at.look'),
    clip: clip,
    spring: spring == null
        ? null
        : FigureSpring(
            stiffness: _number(spring['stiffness'], '$at.spring.stiffness'),
            damping: _number(spring['damping'], '$at.spring.damping'),
            gain: _optionalNumber(spring['gain']),
            limit: _optionalNumber(spring['limit']),
            hang: _optionalNumber(spring['hang']),
          ),
    shapes: [for (final shape in _shapeList(p['shapes'], '$at.shapes')) _shape(_obj(shape, '$at.shapes[]'), '$at.shapes')],
  );
}

FigureShape _shape(Map<String, Object?> s, String at) => FigureShape(
      path: _geometry(s, at),
      fill: _optionalString(s['fill'], '$at.fill'),
      stroke: _optionalString(s['stroke'], '$at.stroke'),
      strokeWidth: _optionalNumber(s['strokeWidth']) ?? 1,
      opacity: _optionalNumber(s['opacity']),
      lineCap: switch (s['lineCap']) { 'butt' => StrokeCap.butt, 'square' => StrokeCap.square, _ => StrokeCap.round },
      lineJoin: switch (s['lineJoin']) { 'miter' => StrokeJoin.miter, 'bevel' => StrokeJoin.bevel, _ => StrokeJoin.round },
      blend: switch (s['blend']) {
        'multiply' => BlendMode.multiply,
        'screen' => BlendMode.screen,
        'overlay' => BlendMode.overlay,
        _ => BlendMode.srcOver,
      },
    );

Path _geometry(Map<String, Object?> s, String at) {
  switch (s['type']) {
    case 'path':
      final d = _string(s['d'], '$at.d');
      if (d.length > maxPathLength || !_pathData.hasMatch(d)) {
        throw FigureFormatException('$at.d must be SVG path data of at most $maxPathLength characters');
      }
      final path = Path();
      try {
        writeSvgPathDataToPath(d, _PathWriter(path));
      } on StateError catch (e) {
        throw FigureFormatException('$at.d: ${e.message}');
      }
      return path;
    case 'ellipse':
      final cx = _number(s['cx'], '$at.cx');
      final cy = _number(s['cy'], '$at.cy');
      final oval = Path()
        ..addOval(Rect.fromCenter(center: Offset(cx, cy), width: _number(s['rx'], '$at.rx') * 2, height: _number(s['ry'], '$at.ry') * 2));
      final rotate = _optionalNumber(s['rotate']) ?? 0;
      if (rotate == 0) return oval;
      final r = rotate * math.pi / 180;
      final cos = math.cos(r), sin = math.sin(r);
      // rotate(deg cx cy) as a column-major 4x4 matrix.
      return oval.transform(Float64List.fromList([
        cos, sin, 0, 0, //
        -sin, cos, 0, 0,
        0, 0, 1, 0,
        cx - cos * cx + sin * cy, cy - sin * cx - cos * cy, 0, 1,
      ]));
    default:
      throw FigureFormatException('$at.type must be "path" or "ellipse"');
  }
}

FigureGradient _gradient(Map<String, Object?> g, String at) {
  final stopsJson = _list(g['stops'], '$at.stops');
  if (stopsJson.isEmpty || stopsJson.length > maxGradientStops) throw FigureFormatException('$at.stops needs 1–$maxGradientStops stops');
  final stops = [
    for (final stop in stopsJson)
      if (_obj(stop, '$at.stops[]') case final s)
        GradientStop(_number(s['offset'], '$at.stops.offset'), _string(s['color'], '$at.stops.color'), _optionalNumber(s['opacity'])),
  ];
  return switch (g['type']) {
    'linear' => LinearFigureGradient(_point(g['from'], '$at.from'), _point(g['to'], '$at.to'), stops),
    'radial' => RadialFigureGradient(
        _point(g['center'], '$at.center'),
        _positive(g['radius'], '$at.radius'),
        g['focus'] == null ? null : _point(g['focus'], '$at.focus'),
        stops,
      ),
    _ => throw FigureFormatException('$at.type must be "linear" or "radial"'),
  };
}

FigureBehavior _behavior(Object? json) {
  if (json == null) return const FigureBehavior();
  final b = _obj(json, 'behavior');
  final weights = <FigureState, double>{};
  for (final MapEntry(:key, :value) in _obj(b['weights'] ?? const {}, 'behavior.weights').entries) {
    final state = autonomousActions.where((s) => s.name == key).firstOrNull;
    if (state != null && value is num && value.isFinite && value >= 0) weights[state] = value.toDouble();
  }
  return FigureBehavior(
    weights: weights,
    walkSpeed: _optionalNumber(b['walkSpeed']) ?? 1,
    jumpPower: _optionalNumber(b['jumpPower']) ?? 1,
    idleProp: _optionalString(b['idleProp'], 'behavior.idleProp') ?? 'none',
    fallProp: _optionalString(b['fallProp'], 'behavior.fallProp') ?? 'none',
  );
}

class _PathWriter extends PathProxy {
  _PathWriter(this.path);
  final Path path;
  @override
  void moveTo(double x, double y) => path.moveTo(x, y);
  @override
  void lineTo(double x, double y) => path.lineTo(x, y);
  @override
  void cubicTo(double x1, double y1, double x2, double y2, double x3, double y3) => path.cubicTo(x1, y1, x2, y2, x3, y3);
  @override
  void close() => path.close();
}

Map<String, Object?> _obj(Object? v, String at) {
  if (v is Map) return v.cast<String, Object?>();
  throw FigureFormatException('$at must be an object');
}

List<Object?> _list(Object? v, String at) {
  if (v is List) return v.cast<Object?>();
  throw FigureFormatException('$at must be an array');
}

List<Object?> _shapeList(Object? v, String at) {
  final list = _list(v, at);
  if (list.isEmpty || list.length > maxShapesPerPart) throw FigureFormatException('$at needs 1–$maxShapesPerPart shapes');
  return list;
}

String? _optionalString(Object? v, String at) {
  if (v == null || v is String) return v as String?;
  throw FigureFormatException('$at must be a string');
}

String _string(Object? v, String at) {
  if (v is String && v.isNotEmpty) return v;
  throw FigureFormatException('$at must be a non-empty string');
}

double _number(Object? v, String at) {
  if (v is num && v.isFinite) return v.toDouble();
  throw FigureFormatException('$at must be a number');
}

double? _optionalNumber(Object? v) => v is num && v.isFinite ? v.toDouble() : null;

double _positive(Object? v, String at) {
  final n = _number(v, at);
  if (n <= 0) throw FigureFormatException('$at must be positive');
  return n;
}

List<double> _numbers(Object? v, String at, int length) {
  final list = _list(v, at);
  if (list.length != length) throw FigureFormatException('$at must have $length numbers');
  return [for (var i = 0; i < length; i++) _number(list[i], '$at[$i]')];
}

Offset _point(Object? v, String at) {
  final p = _numbers(v, at, 2);
  return Offset(p[0], p[1]);
}

Map<String, String> _localized(Object? v, String at) {
  if (v is String) return {'': v};
  return {
    for (final MapEntry(:key, :value) in _obj(v, at).entries)
      if (value is String) key: value,
  };
}

final _hex = RegExp(r'^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$');
final _func = RegExp(r'^(rgba?|hsla?)\(([0-9.,%\s/+-]+)\)$');

/// Parses the color literals figures may use: hex, `rgb()`, `hsl()`,
/// `transparent` and `none` (null paint is returned as transparent).
Color? parseColor(String value) {
  if (value == 'none' || value == 'transparent') return const Color(0x00000000);
  if (_hex.hasMatch(value)) {
    var hex = value.substring(1);
    if (hex.length <= 4) hex = hex.split('').map((c) => '$c$c').join();
    final rgb = int.parse(hex.substring(0, 6), radix: 16);
    final alpha = hex.length == 8 ? int.parse(hex.substring(6), radix: 16) : 255;
    return Color((alpha << 24) | rgb);
  }
  final match = _func.firstMatch(value);
  if (match == null) return null;
  final parts = match.group(2)!.split(RegExp(r'[\s,/]+')).where((p) => p.isNotEmpty).toList();
  if (parts.length < 3 || parts.length > 4) return null;
  double? channel(String p, double scale) {
    final percent = p.endsWith('%');
    final n = double.tryParse(percent ? p.substring(0, p.length - 1) : p);
    if (n == null) return null;
    return percent ? n / 100 * scale : n;
  }

  final alpha = parts.length == 4 ? channel(parts[3], 1) : 1.0;
  if (alpha == null) return null;
  if (match.group(1)!.startsWith('rgb')) {
    final rgb = [for (final p in parts.take(3)) channel(p, 255)];
    if (rgb.contains(null)) return null;
    double unit(double v) => v.clamp(0, 1).toDouble();
    return Color.from(alpha: unit(alpha), red: unit(rgb[0]! / 255), green: unit(rgb[1]! / 255), blue: unit(rgb[2]! / 255));
  }
  final h = double.tryParse(parts[0].replaceAll('deg', ''));
  final s = channel(parts[1], 1);
  final l = channel(parts[2], 1);
  if (h == null || s == null || l == null) return null;
  return _hsl(alpha.clamp(0, 1).toDouble(), h % 360, s.clamp(0, 1).toDouble(), l.clamp(0, 1).toDouble());
}

Color _hsl(double alpha, double hue, double saturation, double lightness) {
  final chroma = (1 - (2 * lightness - 1).abs()) * saturation;
  final h = hue / 60;
  final x = chroma * (1 - (h % 2 - 1).abs());
  final (r, g, b) = switch (h) {
    < 1 => (chroma, x, 0.0),
    < 2 => (x, chroma, 0.0),
    < 3 => (0.0, chroma, x),
    < 4 => (0.0, x, chroma),
    < 5 => (x, 0.0, chroma),
    _ => (chroma, 0.0, x),
  };
  final m = lightness - chroma / 2;
  return Color.from(alpha: alpha, red: r + m, green: g + m, blue: b + m);
}
