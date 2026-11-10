import 'dart:math' as math;
import 'dart:ui';

import 'figure.dart';

/// Procedural animation for the standard skeleton, ported from the web SDK
/// (`src/figure/motion.ts`). Keep the two in step.
///
/// What makes it read as natural rather than mechanical:
/// - every state change crossfades from the pose actually on screen;
/// - idle movement is driven by smooth noise, not a metronome;
/// - eyes turn first, the head follows a beat later;
/// - the walk cycle is driven by distance travelled, so feet do not slide;
/// - anticipation before actions, squash on landing scaled by impact;
/// - springs on hair and ribbons (in the renderer) provide follow-through.

/// Per-bone pose: rotation in degrees, offset in viewBox units, scale.
class BonePose {
  BonePose({this.rotate, this.x, this.y, this.sx, this.sy});
  double? rotate;
  double? x;
  double? y;
  double? sx;
  double? sy;

  BonePose copy() => BonePose(rotate: rotate, x: x, y: y, sx: sx, sy: sy);
}

typedef Pose = Map<Bone, BonePose>;

/// Her soul floating out of her mouth after a fright.
class Soul {
  const Soul(this.out, this.drift);

  /// 0 at her lips, 1 fully out.
  final double out;

  /// Floating offset in animation units.
  final Offset drift;
}

enum Emote { note, sweat, alert, sleep, heart, dizzy, flash }

enum Mood { neutral, happy, worried }

class MotionFrame {
  const MotionFrame({
    required this.pose,
    required this.slots,
    required this.push,
    required this.emote,
    required this.look,
    required this.cut,
    required this.soul,
  });

  final Pose pose;
  final Map<String, String> slots;

  /// Whole-figure acceleration for springs, viewBox units/s².
  final Offset push;
  final Emote? emote;

  /// Gaze override (-1..1 per axis); null follows the pointer.
  final Offset? look;

  /// Hide everything below the anchor line, as if behind the perch edge.
  final bool cut;
  final Soul? soul;
}

/// Figure measurements the edge poses need, in animation units.
class Geometry {
  const Geometry({required this.unit, required this.anchor, required this.seat, required this.chest});
  final double unit;
  final double anchor;
  final double seat;
  final double chest;

  factory Geometry.of(Figure figure) {
    final unit = figure.unit;
    final shoulder = figure.skeleton[Bone.armL]!.dy / unit;
    final hip = figure.skeleton[Bone.legL]!.dy / unit;
    return Geometry(unit: unit, anchor: figure.anchor.dy / unit, seat: hip + 4, chest: shoulder + 16);
  }
}

const _defaultGeometry = Geometry(unit: 1, anchor: 256, seat: 212, chest: 162);
const _blend = 0.26;
const _stride = 30.0;
const _soulDelay = 0.12;
const _soulOut = 0.35;
const _soulIn = 0.18;
const _soulLinger = 0.5;
const _tau = math.pi * 2;

double _clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);
double _wave(double t, double period, [double phase = 0]) => math.sin((t / period) * _tau + phase);
double _ease(double x) => x <= 0 ? 0 : (x >= 1 ? 1 : x * x * (3 - 2 * x));

/// Overshoots past 1 and settles: used for pops and landings.
double _backOut(double x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c = 2.2;
  final d = x - 1;
  return 1 + (c + 1) * d * d * d + c * d * d;
}

/// Smooth 1D value noise in -1..1, deterministic per seed.
double noise(double t, [double seed = 0]) {
  double hash(double n) {
    final x = math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (x - x.floorToDouble()) * 2 - 1;
  }

  final i = t.floorToDouble();
  final u = _ease(t - i);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

double _drift(double t, double seed) => noise(t, seed) * 0.65 + noise(t * 2.3, seed + 9) * 0.35;

Pose _mix(Pose from, Pose to, double k) {
  final out = <Bone, BonePose>{};
  for (final bone in Bone.values) {
    final a = from[bone];
    final b = to[bone];
    if (a == null && b == null) continue;
    double lerp(double? va, double? vb, double base) {
      final x = va ?? base;
      return x + ((vb ?? base) - x) * k;
    }

    out[bone] = BonePose(
      rotate: lerp(a?.rotate, b?.rotate, 0),
      x: lerp(a?.x, b?.x, 0),
      y: lerp(a?.y, b?.y, 0),
      sx: lerp(a?.sx, b?.sx, 1),
      sy: lerp(a?.sy, b?.sy, 1),
    );
  }
  return out;
}

class Motion {
  Motion({FigureBehavior? behavior, double Function()? random, Geometry geometry = _defaultGeometry})
      : _random = random ?? math.Random().nextDouble,
        _speed = behavior?.walkSpeed ?? 1,
        _prop = behavior?.idleProp ?? 'none',
        _fallProp = behavior?.fallProp ?? 'none',
        _geometry = geometry,
        _unit = geometry.unit {
    _calm = 1 / _clamp(_speed, 0.6, 1.4);
    _held = heldProps.contains(_prop) ? _prop : null;
    _seed = (_random() * 1000).floorToDouble();
  }

  final double Function() _random;
  final double _speed;
  final String _prop;
  final String _fallProp;
  final Geometry _geometry;
  final double _unit;
  late final double _calm;
  late final String? _held;
  late final double _seed;

  FigureState _state = FigureState.idle;
  double _since = 0;
  double _time = 0;
  double _nextBlink = 1.5;
  double _blinkUntil = 0;
  bool _doubleBlink = false;
  double _talkFlip = 0;
  String _talkShape = 'talk';
  Mood _mood = Mood.neutral;
  double _impact = 0;
  bool _landed = false;
  double _soul = 0;
  double _soulLingerFor = 0;
  bool _fright = true;
  double _alertUntil = -1;
  double _walkPhase = 0;
  double? _walkSpeed;
  Offset _gaze = Offset.zero;
  double _headTurn = 0;
  Pose _last = {};
  Pose _from = {};
  Map<String, String> _lastSlots = {};
  Map<String, String> _fromSlots = {};
  double _blendFor = _blend;

  FigureState get current => _state;

  /// Plays a state; a fall frightens her unless [setFright] turns that off.
  void play(FigureState state) {
    if (state == FigureState.fall) _fright = true;
    if (state == _state) return;
    // A jump's crouch must read immediately; other changes ease in.
    _begin(state, state == FigureState.jump ? 0.08 : _blend);
    _landed = false;
  }

  /// Whether the current fall frightens her (her soul slips out).
  void setFright(bool on) => _fright = on;

  void setMood(Mood mood) => _mood = mood;

  /// Where the pointer is, -1..1; the head follows the eyes with a lag.
  void setGaze(double x, double y) => _gaze = Offset(x, y);

  /// Horizontal walking speed in viewBox units/s; null uses the figure's own pace.
  void setWalkSpeed(double? unitsPerSecond) => _walkSpeed = unitsPerSecond == null ? null : unitsPerSecond / _unit;

  /// Ends a fall or jump with a squash; above 0.85 she is briefly dizzy.
  void land([double impact = 0.5]) {
    // Impacts are instant: no crossfade, or the squash would be swallowed.
    _begin(FigureState.idle, 0);
    _landed = true;
    _impact = _clamp(impact, 0, 1);
    _soulLingerFor = _soul > 0.2 ? _soulLinger : 0;
  }

  /// A short startled "!" over her head.
  void exclaim() => _alertUntil = _time + 0.9;

  MotionFrame update(double dt) {
    _time += dt;
    _since += dt;
    final t = _time;
    final s = _since;
    final c = _calm;
    final g = _geometry;
    final pose = <Bone, BonePose>{};
    final slots = <String, String>{'eyes': 'open', 'mouth': 'smile', 'brows': 'calm', 'hand': 'rest', 'armL': 'rest', 'armR': 'rest'};
    var push = Offset.zero;
    Emote? emote;
    Offset? look;
    var cut = false;

    final turnTarget = _clamp(_gaze.dx, -1, 1) * 5;
    _headTurn += (turnTarget - _headTurn) * (1 - math.exp(-dt * 2.6));

    // Breathing plus noise-driven sway runs under every state.
    final breath = _wave(t, 3.4 * c);
    final n = t / (2.2 * c);
    pose[Bone.body] = BonePose(sy: 1 + breath * 0.012, sx: 1 - breath * 0.004, rotate: _drift(n, _seed) * 1.1);
    pose[Bone.head] = BonePose(rotate: _drift(n * 0.8, _seed + 3) * 3 + _headTurn, y: breath * -0.4);
    pose[Bone.armL] = BonePose(rotate: 1.5 + _drift(n, _seed + 5) * 1.5);
    pose[Bone.armR] = BonePose(rotate: -1.5 - _drift(n, _seed + 7) * 1.5);
    pose[Bone.hips] = BonePose(x: _drift(n * 0.6, _seed + 11) * 0.6);
    BonePose head() => pose[Bone.head]!;

    if (_mood == Mood.happy) {
      slots['eyes'] = 'happy';
      slots['mouth'] = 'open';
      head().rotate = (head().rotate ?? 0) + 6;
    } else if (_mood == Mood.worried) {
      slots['brows'] = 'worried';
      slots['mouth'] = 'o';
    }

    final heldProp = _mood == Mood.neutral ? _held : null;
    final reading = heldProp == 'book';

    final frightened = _state == FigureState.fall
        ? _fright && _fallProp != 'umbrella' && s > _soulDelay
        : _landed && _state == FigureState.idle && s < _soulLingerFor;
    _soul = frightened ? math.min(1, _soul + dt / _soulOut) : math.max(0, _soul - dt / _soulIn);

    switch (_state) {
      case FigureState.idle:
        if (heldProp != null) {
          slots['hand'] = heldProp;
          slots['armL'] = slots['armR'] = 'bent';
          pose[Bone.armL] = BonePose(rotate: breath * 0.6);
          pose[Bone.armR] = BonePose(rotate: -breath * 0.6);
        }
        if (reading) {
          head().rotate = (head().rotate ?? 0) * 0.3 + 3;
          head().y = (head().y ?? 0) + 1.6;
          look = Offset(((t * 0.45) % 1) * 1.6 - 0.8, 0.9);
        } else if (_prop == 'stretch' && _mood == Mood.neutral) {
          final period = 14 * c;
          final cycle = (t % period) - (period - 2.2);
          if (cycle > 0) {
            final k = math.sin((cycle / 2.2) * math.pi);
            if (k > 0.2) {
              slots['armL'] = slots['armR'] = 'up';
              final lift = _ease((k - 0.2) / 0.8);
              pose[Bone.armL] = BonePose(rotate: -25 * (1 - lift) + 12 * lift);
              pose[Bone.armR] = BonePose(rotate: 25 * (1 - lift) - 12 * lift);
            } else {
              pose[Bone.armL] = BonePose(rotate: 30 * k);
              pose[Bone.armR] = BonePose(rotate: -30 * k);
            }
            pose[Bone.root] = BonePose(sy: 1 + 0.05 * k, sx: 1 - 0.03 * k);
            head().rotate = (head().rotate ?? 0) * 0.3 - 3 * k;
            slots['eyes'] = k > 0.25 ? 'closed' : 'open';
            slots['mouth'] = k > 0.35 ? 'open' : 'smile';
          }
        } else if (heldProp == 'cup') {
          final period = 7 * c;
          final phase = t % period;
          if (phase > period - 1.6) {
            final dip = math.sin(((phase - (period - 1.6)) / 1.6) * math.pi);
            head().rotate = (head().rotate ?? 0) * 0.4 + 5 * dip;
            head().y = (head().y ?? 0) + 2.5 * dip;
            slots['eyes'] = 'closed';
            slots['mouth'] = 'flat';
          } else if (phase < 1 && t > period) {
            slots['eyes'] = 'happy';
            emote = Emote.heart;
          }
        } else if (heldProp == 'camera') {
          final period = 8 * c;
          final phase = t % period;
          if (phase > period - 1.4) {
            final lean = _ease((phase - (period - 1.4)) / 0.4);
            head().rotate = (head().rotate ?? 0) * 0.4 + 4 * lean;
            head().y = (head().y ?? 0) + 1.5 * lean;
            look = const Offset(0, 0.3);
            slots['mouth'] = 'flat';
            if (phase > period - 0.45) {
              emote = Emote.flash;
              slots['eyes'] = 'closed';
              pose[Bone.root] = BonePose(sy: 0.98, sx: 1.01);
            }
          } else if (phase < 1.1 && t > period) {
            slots['eyes'] = 'happy';
            slots['mouth'] = 'open';
          }
        } else if (_prop == 'gum' && _mood == Mood.neutral) {
          final period = 10 * c;
          final k = (t % period) - (period - 2.4);
          if (k > 0) {
            if (k < 0.8) {
              slots['mouth'] = 'gum';
            } else if (k < 1.9) {
              slots['mouth'] = 'gumBig';
              if (k > 1.5) slots['eyes'] = 'closed';
            } else {
              slots['mouth'] = 'o';
              slots['eyes'] = 'closed';
              emote = Emote.alert;
              head().rotate = (head().rotate ?? 0) + _wave(k, 0.2) * 3;
              pose[Bone.root] = BonePose(sy: 0.97, sx: 1.02);
            }
          }
        }

      case FigureState.wave:
        final up = _backOut(_ease((s - 0.06) / 0.3));
        final flap = _wave(s, 0.44) * 9 * _ease((s - 0.3) / 0.2);
        if (s > 0.06) slots['armR'] = 'up';
        pose[Bone.armR] = s > 0.06 ? BonePose(rotate: (1 - up) * 45 + flap) : BonePose(rotate: -6 * _ease(s / 0.06));
        pose[Bone.armL] = BonePose(rotate: 3);
        head().rotate = (head().rotate ?? 0) - 7 * up;
        pose[Bone.body]!.rotate = (pose[Bone.body]!.rotate ?? 0) - 2.5 * up;
        slots['eyes'] = 'happy';
        slots['mouth'] = 'open';
        if (s < 1.6) emote = Emote.note;

      case FigureState.talk:
        _talkFlip -= dt;
        if (_talkFlip <= 0) {
          _talkFlip = 0.07 + _random() * 0.09;
          final r = _random();
          _talkShape = r < 0.45 ? 'talk' : (r < 0.75 ? 'open' : (r < 0.9 ? 'o' : 'smile'));
        }
        slots['mouth'] = _talkShape;
        head().rotate = (head().rotate ?? 0) + _wave(t, 1.3) * 3;
        head().y = (head().y ?? 0) + _wave(t, 0.36).abs() * -0.8;
        pose[Bone.armL] = BonePose(rotate: 3 + _wave(t, 1.1) * 3);

      case FigureState.think:
        head().rotate = (head().rotate ?? 0) * 0.4 - 9;
        slots['armL'] = slots['armR'] = 'bent';
        pose[Bone.armL] = BonePose(rotate: -3);
        pose[Bone.armR] = BonePose(rotate: 3 + _wave(t, 3.1) * 1.2);
        slots['mouth'] = 'flat';
        slots['brows'] = 'worried';
        look = const Offset(0.5, -0.8);

      case FigureState.sleep:
        final deep = _wave(t, 4.6);
        pose[Bone.body] = BonePose(sy: 1 + deep * 0.02, sx: 1 - deep * 0.006, rotate: -2);
        pose[Bone.head] = BonePose(rotate: 11 + _wave(t, 4.6, 0.6) * 2.5, y: 2.5 + deep * 0.8);
        pose[Bone.armL] = BonePose(rotate: 1);
        pose[Bone.armR] = BonePose(rotate: -1);
        slots['eyes'] = 'sleepy';
        slots['mouth'] = 'o';
        emote = Emote.sleep;

      case FigureState.walk:
        // Phase follows distance, so each step covers what the feet push.
        final speed = _walkSpeed ?? 44 * _speed;
        _walkPhase += (speed.abs() * dt) / (_stride * 2);
        final phase = _walkPhase * _tau;
        final swing = math.sin(phase);
        final bob = math.sin(phase).abs();
        pose[Bone.legL] = BonePose(rotate: swing * 18);
        pose[Bone.legR] = BonePose(rotate: -swing * 18);
        pose[Bone.armL] = BonePose(rotate: 2 - swing * 9);
        pose[Bone.armR] = BonePose(rotate: -2 + swing * 9);
        pose[Bone.hips] = BonePose(y: -bob * 3.2, rotate: swing * 2);
        pose[Bone.body] = pose[Bone.body]!.copy()..rotate = 3 + swing * 1.5;
        pose[Bone.head] = head().copy()
          ..rotate = (head().rotate ?? 0) - math.sin(phase - 0.6) * 2.5
          ..y = math.sin(phase - 0.5).abs() * 0.9;
        push = Offset(math.cos(phase) * 160, 0);

      case FigureState.jump:
        // Crouch (anticipation), stretch on takeoff, tuck in the air.
        final crouch = _ease(s / 0.16);
        final air = _ease((s - 0.16) / 0.12);
        final sy = 1 - 0.14 * crouch + 0.24 * air;
        final sx = 1 + 0.1 * crouch - 0.12 * air;
        pose[Bone.root] = BonePose(sy: math.max(0.8, sy - 0.1 * _ease((s - 0.4) / 0.2)), sx: sx);
        if (air > 0.3) {
          slots['armL'] = slots['armR'] = 'up';
          pose[Bone.armL] = BonePose(rotate: -40 * (1 - air));
          pose[Bone.armR] = BonePose(rotate: 40 * (1 - air));
        } else {
          pose[Bone.armL] = BonePose(rotate: 22 * crouch);
          pose[Bone.armR] = BonePose(rotate: -22 * crouch);
        }
        pose[Bone.legL] = BonePose(rotate: -10 * air);
        pose[Bone.legR] = BonePose(rotate: 14 * air);
        slots['eyes'] = s < 0.16 ? 'closed' : 'open';
        slots['mouth'] = 'open';
        push = Offset(0, air > 0 && air < 1 ? -2200 : 0);

      case FigureState.fall:
        if (_fallProp == 'umbrella') {
          slots['hand'] = 'umbrella';
          slots['armR'] = 'up';
          pose[Bone.armR] = BonePose(rotate: _wave(t, 1.6) * 4);
          pose[Bone.armL] = BonePose(rotate: 8 + _wave(t, 1.6, 1) * 3);
          pose[Bone.legL] = BonePose(rotate: _wave(t, 1.4) * 8);
          pose[Bone.legR] = BonePose(rotate: _wave(t, 1.4, 1.2) * 8);
          if (s > 0.4) emote = Emote.note;
          break;
        }
        // Flailing, until her soul is out and she goes limp.
        final flail = 1 - _soul * 0.75;
        slots['armL'] = slots['armR'] = 'up';
        pose[Bone.armL] = BonePose(rotate: -8 + _wave(t, 0.3) * 9 * flail);
        pose[Bone.armR] = BonePose(rotate: 8 - _wave(t, 0.3, 1.4) * 9 * flail);
        pose[Bone.legL] = BonePose(rotate: _wave(t, 0.4) * 12 * flail);
        pose[Bone.legR] = BonePose(rotate: -_wave(t, 0.4) * 12 * flail);
        slots['mouth'] = 'o';
        slots['brows'] = 'worried';
        emote = Emote.sweat;

      case FigureState.drag:
        slots['armL'] = slots['armR'] = 'up';
        pose[Bone.armL] = BonePose(rotate: -12 + _wave(t, 0.34) * 10);
        pose[Bone.armR] = BonePose(rotate: 12 - _wave(t, 0.34, 1.3) * 10);
        pose[Bone.legL] = BonePose(rotate: _wave(t, 0.28) * 22);
        pose[Bone.legR] = BonePose(rotate: _wave(t, 0.28, math.pi) * 22);
        pose[Bone.body] = BonePose(rotate: _wave(t, 0.9) * 5);
        slots['brows'] = 'worried';
        slots['mouth'] = 'o';
        slots['eyes'] = _wave(t, 1.8) > 0.6 ? 'closed' : 'open';
        emote = Emote.sweat;

      case FigureState.sit:
        pose[Bone.root] = BonePose(y: g.anchor - g.seat);
        pose[Bone.legL] = BonePose(sy: 0.8, rotate: _drift(t / 1.4, _seed + 13) * 10 + _wave(t, 1.7 * c) * 8);
        pose[Bone.legR] = BonePose(sy: 0.8, rotate: _drift(t / 1.4, _seed + 17) * 10 + _wave(t, 1.7 * c, 2.2) * 8);
        pose[Bone.armL] = BonePose(rotate: 5);
        pose[Bone.armR] = BonePose(rotate: -5);
        if (heldProp != null) {
          slots['hand'] = heldProp;
          slots['armL'] = slots['armR'] = 'bent';
          pose[Bone.armL] = BonePose(rotate: 0);
          pose[Bone.armR] = BonePose(rotate: 0);
          head().rotate = (head().rotate ?? 0) * 0.3 + 3;
          if (reading) look = Offset(((t * 0.45) % 1) * 1.6 - 0.8, 0.9);
        }

      case FigureState.lie:
        // Lying on top of an edge: below the chest is behind it, chin on folded arms.
        cut = true;
        pose[Bone.root] = BonePose(y: g.anchor - g.chest);
        slots['armL'] = slots['armR'] = 'fold';
        pose[Bone.armL] = BonePose(rotate: breath * 0.8);
        pose[Bone.armR] = BonePose(rotate: -breath * 0.8);
        pose[Bone.head] = head().copy()
          ..y = (head().y ?? 0) + 5
          ..rotate = (head().rotate ?? 0) + 6 + _wave(t, 4.2 * c) * 3;
        pose[Bone.body] = pose[Bone.body]!.copy()..sy = 0.96 + breath * 0.01;
        final kick = _wave(t, 1.1 * c);
        final lift = -(g.anchor - g.chest) - 26;
        pose[Bone.legL] = BonePose(rotate: -150 + kick * 18, x: 60, y: lift);
        pose[Bone.legR] = BonePose(rotate: -164 - kick * 18, x: 50, y: lift - 6);
        if (_mood == Mood.neutral && _wave(t, 9) > 0.85) slots['mouth'] = 'talk';

      case FigureState.hang:
        // Clinging to an edge: forearms folded over it, body dangling in front.
        pose[Bone.root] = BonePose(y: g.anchor - g.chest);
        slots['armL'] = slots['armR'] = 'fold';
        final swing = _wave(t, 1.3) * math.exp(-s * 0.6);
        pose[Bone.armL] = BonePose(rotate: -swing * 2);
        pose[Bone.armR] = BonePose(rotate: -swing * 2);
        pose[Bone.head] = head().copy()
          ..y = (head().y ?? 0) + 4
          ..rotate = (head().rotate ?? 0) * 0.5;
        pose[Bone.hips] = BonePose(rotate: swing * 5);
        pose[Bone.legL] = BonePose(rotate: _wave(t, 0.5) * 14);
        pose[Bone.legR] = BonePose(rotate: _wave(t, 0.5, math.pi) * 14);
        slots['brows'] = 'worried';
        slots['mouth'] = s > 1.2 ? 'flat' : 'o';
        emote = Emote.sweat;
    }

    // Landing pop: squash then spring back with overshoot, scaled by impact.
    if (_landed && _state == FigureState.idle) {
      final duration = 0.35 + _impact * 0.25;
      if (s < duration) {
        final k = _backOut(s / duration);
        final depth = 0.08 + _impact * 0.16;
        pose[Bone.root] = BonePose(sy: 1 - depth + depth * k, sx: 1 + depth * 0.7 - depth * 0.7 * k);
      }
      if (_impact > 0.85 && s < 1.6) {
        emote = Emote.dizzy;
        slots['eyes'] = 'closed';
        head().rotate = (head().rotate ?? 0) + _wave(s, 0.5) * 6;
      }
    }

    if (t < _alertUntil) {
      emote = Emote.alert;
      slots['eyes'] = 'open';
      slots['mouth'] = 'o';
    }

    // With her soul out the eyes go blank and her mouth hangs open.
    if (_soul > 0) {
      slots['eyes'] = 'open';
      slots['mouth'] = 'o';
      emote = null;
    }

    // Natural blinking, sometimes twice; never over closed, happy or blank eyes.
    if (slots['eyes'] == 'open' && _soul == 0) {
      if (t >= _nextBlink) {
        _blinkUntil = t + 0.11;
        if (_doubleBlink) {
          _doubleBlink = false;
          _nextBlink = t + 0.24;
        } else {
          _doubleBlink = _random() < 0.22;
          _nextBlink = t + (2.2 + _random() * 3.6) * c;
        }
      }
      if (t < _blinkUntil) slots['eyes'] = 'closed';
    }

    // Arm drawings swap halfway through a crossfade, when the rotations meet.
    if (s < _blendFor * 0.5) {
      if (_fromSlots['armL'] case final arm?) slots['armL'] = arm;
      if (_fromSlots['armR'] case final arm?) slots['armR'] = arm;
    }
    _lastSlots = {...slots};

    final output = s < _blendFor ? _mix(_from, pose, _ease(s / _blendFor)) : pose;
    _last = output;
    // Retain canonical poses for future blends; only the renderer receives drawing units.
    var rendered = output;
    if (_unit != 1) {
      rendered = {
        for (final MapEntry(key: bone, value: p) in output.entries)
          bone: p.copy()
            ..x = p.x == null ? null : p.x! * _unit
            ..y = p.y == null ? null : p.y! * _unit,
      };
    }
    final soul = _soul > 0 ? Soul(_ease(_soul), Offset(_wave(t, 1.7) * 4, _wave(t, 1.1, 1) * 3)) : null;
    return MotionFrame(pose: rendered, slots: slots, push: push * _unit, emote: emote, look: look, cut: cut, soul: soul);
  }

  void _begin(FigureState state, double blend) {
    _from = _last;
    _fromSlots = {..._lastSlots};
    _blendFor = blend;
    _state = state;
    _since = 0;
  }
}
