import 'dart:math' as math;

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'figure.dart';
import 'figure_view.dart';
import 'perch.dart';
import 'physics.dart';

/// How often she moves on her own.
enum PeettyActivity { calm, normal, lively }

const _base = {
  FigureState.idle: 3.0,
  FigureState.walk: 3.0,
  FigureState.jump: 2.0,
  FigureState.sit: 2.0,
  FigureState.lie: 1.0,
  FigureState.sleep: 0.6,
  FigureState.think: 0.4,
};
const _activity = {
  PeettyActivity.calm: {FigureState.walk: 0.5, FigureState.jump: 0.35, FigureState.sit: 1.6, FigureState.lie: 1.3, FigureState.sleep: 1.6},
  PeettyActivity.normal: <FigureState, double>{},
  PeettyActivity.lively: {FigureState.walk: 1.4, FigureState.jump: 1.9, FigureState.sit: 0.7, FigureState.sleep: 0.5},
};
const _duration = {
  FigureState.idle: (2.5, 6.0),
  FigureState.sit: (8.0, 18.0),
  FigureState.lie: (8.0, 16.0),
  FigureState.sleep: (12.0, 25.0),
  FigureState.think: (3.0, 5.0),
  FigureState.wave: (1.7, 1.7),
};
const _throwMax = 2000.0;
const _retryMs = 1200.0;

enum _Mode { paused, ground, jump, fall, hang, drag }

class _Flight {
  _Flight({required this.from, required this.plan, required this.target, required this.hang, required this.fright}) : origin = Offset(target.left, target.y);
  final Offset from;
  final Jump plan;
  Perch target;
  final Offset origin;
  final bool hang;
  final bool fright;

  /// Starts negative: she crouches in place before take-off.
  double t = -0.18;
}

/// A companion living on top of [child]: she stands on [PeettyPerch] edges
/// and the bottom of the screen, walks and jumps between them, follows them
/// as they scroll, falls when one disappears, and can be picked up and thrown.
///
/// Wrap a whole app with `MaterialApp(builder: (context, child) => Peetty(child: child!))`
/// or a single screen.
class Peetty extends StatefulWidget {
  const Peetty({
    super.key,
    required this.child,
    this.figure = 'miru',
    this.figureData,
    this.scale = 1,
    this.activity = PeettyActivity.normal,
    this.visible = true,
    this.random,
  });

  final Widget child;

  /// A bundled figure id; see [presetFigures].
  final String figure;

  /// A custom figure, used instead of [figure].
  final Figure? figureData;

  /// Display scale relative to the figure's own height.
  final double scale;
  final PeettyActivity activity;

  /// Hides her without losing her figure.
  final bool visible;

  /// Seeded randomness for tests.
  final double Function()? random;

  /// The nearest companion above [context], for triggering actions.
  static PeettyState? maybeOf(BuildContext context) => context.findAncestorStateOfType<PeettyState>();

  @override
  State<Peetty> createState() => PeettyState();
}

class PeettyState extends State<Peetty> with SingleTickerProviderStateMixin {
  final _registry = PerchRegistry();
  final _hostKey = GlobalKey();
  late final Ticker _ticker;
  late double Function() _random;
  FigureController? _view;
  Object? _loading;
  Duration _lastTick = Duration.zero;
  bool _reducedMotion = false;
  EdgeInsets _padding = EdgeInsets.zero;
  Size? _screen;
  AssetBundle? _bundle;

  /// Frame time in ms; every timing decision uses this clock.
  double _clock = 0;
  _Mode _mode = _Mode.paused;
  double _retryAt = 0;
  double _x = 0, _y = 0, _vx = 0, _vy = 0;
  Perch? _perch;
  FigureState _action = FigureState.idle;
  double _until = 0;
  double _walkTo = 0;
  _Flight? _flight;
  bool _calmFall = false;
  double _hangUntil = 0;
  double _lastGreet = double.negativeInfinity;
  Offset? _pointer;

  /// The figure on screen, once loaded.
  Figure? get figure => _view?.figure;

  /// What she is doing now.
  FigureState get action => _mode == _Mode.ground ? _action : (_view?.motion.current ?? FigureState.idle);

  /// Where her feet are, in host coordinates; null while she is away.
  Offset? get position => _mode == _Mode.paused ? null : Offset(_x, _y);

  @override
  void initState() {
    super.initState();
    _random = widget.random ?? math.Random().nextDouble;
    _ticker = createTicker(_tick);
  }

  @override
  void didUpdateWidget(Peetty oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.random != oldWidget.random) _random = widget.random ?? math.Random().nextDouble;
    if (widget.figure != oldWidget.figure || widget.figureData != oldWidget.figureData || widget.scale != oldWidget.scale) _load();
    if (widget.visible != oldWidget.visible) {
      if (widget.visible) {
        _startTicker();
      } else {
        // Hidden: park her and stop scheduling frames until she is shown again.
        _park();
        _ticker.stop();
      }
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reducedMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    _padding = MediaQuery.maybePaddingOf(context) ?? EdgeInsets.zero;
    _screen = MediaQuery.maybeSizeOf(context);
    // Inherited lookups belong here, not in initState.
    final bundle = DefaultAssetBundle.of(context);
    if (bundle != _bundle) {
      final first = _bundle == null;
      _bundle = bundle;
      if (first || widget.figureData == null) _load();
    }
  }

  void _startTicker() {
    if (_ticker.isActive || _view == null || !widget.visible) return;
    // A restarted ticker counts from zero again.
    _lastTick = Duration.zero;
    _ticker.start();
  }

  /// Disposes a replaced controller once the widgets listening to it have let go.
  void _retire(FigureController controller) => WidgetsBinding.instance.addPostFrameCallback((_) => controller.dispose());

  @override
  void dispose() {
    _ticker.dispose();
    _view?.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final request = Object();
    _loading = request;
    final Figure figure;
    try {
      figure = widget.figureData ?? await loadFigure(widget.figure, bundle: _bundle);
    } catch (error, stack) {
      FlutterError.reportError(
        FlutterErrorDetails(exception: error, stack: stack, library: 'peetty', context: ErrorDescription('loading figure "${widget.figure}"')),
      );
      return;
    }
    if (!mounted || _loading != request) return;
    final previous = _view;
    final view = FigureController(figure, scale: widget.scale, random: _random);
    if (previous != null) {
      // Keep her where she is, mid-action, facing the same way.
      view
        ..setFacing(previous.facing)
        ..play(previous.motion.current);
      _retire(previous);
    }
    setState(() => _view = view);
    _startTicker();
  }

  /// Asks her to do something now. Walking and jumping pick their own target;
  /// other actions last [seconds] or their usual time. Ignored unless she is standing.
  void play(FigureState action, {double? seconds}) {
    if (_mode != _Mode.ground || _view == null) return;
    switch (action) {
      case FigureState.walk:
        _startWalk();
      case FigureState.jump:
        if (!_leap()) _setAction(FigureState.idle, _rand(1.5, 3));
      case FigureState.fall || FigureState.drag || FigureState.hang:
        return;
      default:
        final (min, max) = _duration[action] ?? (3.0, 6.0);
        _setAction(action, seconds ?? _rand(min, max));
    }
  }

  // ------------------------------------------------------------ the loop

  void _tick(Duration elapsed) {
    final view = _view;
    if (view == null) return;
    final dt = ((elapsed - _lastTick).inMicroseconds / 1e6).clamp(0.0, 0.05);
    _lastTick = elapsed;
    _clock += dt * 1000;
    final now = _clock;
    final host = _host;
    if (host == null) return;
    switch (_mode) {
      case _Mode.paused:
        if (now < _retryAt || !widget.visible) return;
        _enter(host);
      case _Mode.ground:
        _ground(host, now, dt);
      case _Mode.jump:
        _flying(host, dt);
      case _Mode.fall:
        _falling(host, dt);
      case _Mode.hang:
        _hanging(host, now);
      case _Mode.drag:
        break;
    }
    if (_mode == _Mode.paused) return;
    final pointer = _pointer;
    view.setPointer(pointer == null ? null : pointer - _topLeft(view));
    view.step(dt, reducedMotion: _reducedMotion);
  }

  RenderBox? get _host {
    final object = _hostKey.currentContext?.findRenderObject();
    return object is RenderBox && object.attached && object.hasSize ? object : null;
  }

  Offset _topLeft(FigureController view) => Offset(_x, _y) - view.anchor;

  /// Where her feet may be so that all of her stays on screen.
  Limits? _limits(RenderBox host) {
    final view = _view!;
    final size = host.size;
    Limits? within(EdgeInsets insets) {
      final left = view.anchor.dx + insets.left;
      final right = size.width - (view.width - view.anchor.dx) - insets.right;
      final top = view.anchor.dy + insets.top;
      final bottom = size.height - insets.bottom;
      return right < left || bottom < top ? null : Limits(left, right, top, bottom);
    }

    // A host tilted so far that no whole row or column fits inside the safe band
    // keeps its full area, rather than leaving her nowhere to be.
    return within(_insets(host)) ?? within(EdgeInsets.zero);
  }

  /// The safe-area insets that overlap the host, in host coordinates.
  ///
  /// Screen y is affine in host coordinates, `y = a·x + b·y' + c`, so for a scaled,
  /// rotated, skewed or flipped host the safe band's edges are slanted lines. When
  /// host rows run across the screen (|b| ≥ |a|) the insets are the nearest rows lying
  /// wholly inside the band; when the host is turned sideways they are columns.
  EdgeInsets _insets(RenderBox host) {
    final screen = _screen;
    if (screen == null) return EdgeInsets.zero;
    final transform = host.getTransformTo(null);
    double screenY(double x, double y) => MatrixUtils.transformPoint(transform, Offset(x, y)).dy;
    final c = screenY(0, 0);
    final a = screenY(1, 0) - c;
    final b = screenY(0, 1) - c;
    final safeTop = _padding.top, safeBottom = screen.height - _padding.bottom;
    final size = host.size;
    // The part of one host axis whose points stay inside the band across the other axis.
    (double, double) span(double slope, double across, double acrossLength, double extent) {
      final fromTop = (safeTop - c - math.min(0.0, across * acrossLength)) / slope;
      final fromBottom = (safeBottom - c - math.max(0.0, across * acrossLength)) / slope;
      // A reversed axis (negative slope) meets the bottom band first.
      final (low, high) = slope > 0 ? (fromTop, fromBottom) : (fromBottom, fromTop);
      return (math.max(0.0, low), math.max(0.0, extent - high));
    }

    if (math.max(a.abs(), b.abs()) <= 1e-12) return EdgeInsets.zero;
    if (b.abs() >= a.abs()) {
      final (top, bottom) = span(b, a, size.width, size.height);
      return EdgeInsets.only(top: top, bottom: bottom);
    }
    final (left, right) = span(a, b, size.height, size.width);
    return EdgeInsets.only(left: left, right: right);
  }

  List<Perch> _scan(RenderBox host) {
    final limits = _limits(host);
    return limits == null ? const [] : _registry.scan(host, limits);
  }

  Perch? _refresh(RenderBox host, Perch perch) {
    final limits = _limits(host);
    return limits == null ? null : _registry.refresh(perch, host, limits);
  }

  /// Drops in from the top of the screen above a good perch.
  void _enter(RenderBox host) {
    final perches = _scan(host);
    final choices = perches.where((p) => !p.isFloor).toList();
    final preferred = choices.where((p) => p.preferred).toList();
    final pool = preferred.isNotEmpty ? preferred : (choices.isNotEmpty ? choices : perches);
    if (pool.isEmpty) return _park();
    final target = pool[(_random() * pool.length).floor().clamp(0, pool.length - 1)];
    _x = _rand(target.left, target.right);
    _y = math.min(target.y - 40, _view!.height * 0.6);
    _vx = _vy = 0;
    // Dropping in is planned, so it does not frighten her.
    _startFall(calm: true);
    setState(() {});
  }

  /// No usable surface: step out of view and try again shortly.
  void _park() {
    final wasAway = _mode == _Mode.paused;
    _mode = _Mode.paused;
    _perch = null;
    _flight = null;
    _vx = _vy = 0;
    _retryAt = _clock + _retryMs;
    if (!wasAway && mounted) setState(() {});
  }

  void _ground(RenderBox host, double now, double dt) {
    final live = _perch == null ? null : _refresh(host, _perch!);
    if (live == null) return _startFall();
    // Ride along with the surface as it moves sideways, then stay on its visible span.
    _x = (_x + live.origin - _perch!.origin).clamp(live.left, live.right);
    _walkTo += live.origin - _perch!.origin;
    _perch = live;
    _y = live.y;

    if (_action == FigureState.walk) {
      _walkTo = _walkTo.clamp(live.left, live.right);
      final dx = _walkTo - _x;
      _view!.motion.setWalkSpeed(_pace * _view!.unitsPerPixel);
      if (dx.abs() < 2 || now / 1000 >= _until) {
        // A last step too short to walk is taken at once.
        if (dx.abs() < 2) _x = _walkTo;
        _setAction(FigureState.idle, _rand(0.8, 2));
      } else {
        _face(dx.sign);
        _x += dx.sign * math.min(dx.abs(), _pace * dt);
      }
    } else if (now / 1000 > _until) {
      _decide(host);
    }

    // A friendly wave when the pointer comes close, now and then.
    final pointer = _pointer;
    if (pointer != null && _action == FigureState.idle && now - _lastGreet > 25000 && !_reducedMotion) {
      final dx = pointer.dx - _x;
      final dy = pointer.dy - (_y - _view!.height / 2);
      if (dx * dx + dy * dy < 150 * 150) {
        _lastGreet = now;
        _face(dx == 0 ? 1 : dx.sign);
        _setAction(FigureState.wave, 1.7);
      }
    }
  }

  void _flying(RenderBox host, double dt) {
    final flight = _flight!;
    flight.t += dt;
    if (flight.t < 0) return;
    final plan = flight.plan;
    final arrived = flight.t >= plan.duration;
    final target = _refresh(host, flight.target);
    final progress = math.min(1.0, flight.t / plan.duration);
    final p = along(flight.from, plan, math.min(flight.t, plan.duration));
    // Follow a target that moves during the flight (scrolling).
    final to = flight.from.dx + plan.vx * plan.duration;
    final dest = target == null ? to : (to + target.left - flight.origin.dx).clamp(target.left, target.right);
    _x = p.dx + (dest - to) * progress;
    _y = p.dy + (target == null ? 0 : (target.y - flight.origin.dy) * progress);
    if (target == null) {
      _vx = plan.vx;
      _vy = plan.vy + gravity * flight.t;
      return _startFall();
    }
    // Over the top of a long drop she looks down, and her soul leaves her.
    if (flight.fright && flight.t > -plan.vy / gravity) _view!.play(FigureState.fall);
    flight.target = target;
    if (arrived) {
      _x = _x.clamp(target.left, target.right);
      _y = target.y;
      if (flight.hang) {
        _perch = target;
        _mode = _Mode.hang;
        _hangUntil = _clock + 1500;
        _view!.play(FigureState.hang);
      } else {
        _land(target, impact(plan.vy + gravity * flight.t) * 0.7);
      }
    }
  }

  void _falling(RenderBox host, double dt) {
    final fromY = _y;
    // An open umbrella brakes quickly to a gentle float.
    final cap = _view!.figure.behavior.fallProp == 'umbrella' ? 300.0 : 2400.0;
    _vy = _vy > cap ? math.max(cap, _vy - 3000 * dt) : math.min(_vy + gravity * dt, cap);
    _vx *= math.exp(-dt * 1.5);
    _x += _vx * dt;
    _y += _vy * dt;
    final limits = _limits(host);
    if (limits == null) return _park();
    if (_x < limits.left || _x > limits.right) {
      _x = _x.clamp(limits.left, limits.right);
      _vx = -_vx * 0.4;
    }
    // Thrown upward, she bumps against the top of the screen instead of leaving it.
    if (_vy < 0 && _y < limits.top) {
      _y = limits.top;
      _vy = -_vy * 0.2;
    }
    // A fall frightens her once she is on the way down; a throw carries her up calmly first.
    _view!.motion.setFright(!_calmFall && _vy >= 0);
    final hit = landing(_registry.scan(host, limits).where((p) => !p.isFloor), _x, fromY, _y);
    if (hit != null) return _land(hit, impact(_vy));
    if (_y >= limits.bottom) _land(_registry.floor(limits), impact(_vy));
  }

  void _hanging(RenderBox host, double now) {
    final live = _perch == null ? null : _refresh(host, _perch!);
    if (live == null) return _startFall();
    _x = (_x + live.origin - _perch!.origin).clamp(live.left, live.right);
    _perch = live;
    _y = live.y;
    if (now > _hangUntil) _land(live, 0.25);
  }

  // ------------------------------------------------------------ decisions

  void _decide(RenderBox host) {
    final perch = _perch!;
    final configured = _view!.figure.behavior.weights;
    final activity = _activity[widget.activity]!;
    final weights = <FigureState, double>{};
    for (final action in autonomousActions) {
      final weight = configured[action] ?? _base[action];
      if (weight != null) weights[action] = weight * (activity[action] ?? 1);
    }
    if (_reducedMotion) {
      weights.remove(FigureState.walk);
      weights.remove(FigureState.jump);
    }
    if (perch.right - perch.left < 20) weights.remove(FigureState.walk);
    final choice = weighted([for (final e in weights.entries) (e.key, e.value)], _random) ?? FigureState.idle;
    if (choice == FigureState.jump) {
      if (!_leap()) _setAction(FigureState.idle, _rand(1.5, 3));
    } else if (choice == FigureState.walk) {
      _startWalk();
    } else {
      final (min, max) = _duration[choice] ?? (3.0, 6.0);
      _setAction(choice, _rand(min, max));
    }
  }

  void _startWalk() {
    final host = _host;
    final perch = host == null || _perch == null ? null : _refresh(host, _perch!);
    if (perch == null) return _startFall();
    _perch = perch;
    if (perch.right - perch.left < 2) return _setAction(FigureState.idle, _rand(1.5, 3));
    _x = _x.clamp(perch.left, perch.right);
    var target = _rand(perch.left, perch.right);
    if ((target - _x).abs() < 20) target = _x - perch.left > perch.right - _x ? perch.left : perch.right;
    if ((target - _x).abs() < 2) {
      _x = target;
      return _setAction(FigureState.idle, _rand(1.5, 3));
    }
    _walkTo = target;
    _setAction(FigureState.walk, (target - _x).abs() / _pace + 0.5);
  }

  /// Walking speed in logical pixels per second.
  double get _pace => 52 * _view!.figure.behavior.walkSpeed;

  void _setAction(FigureState action, double seconds) {
    _action = action;
    _until = _clock / 1000 + seconds;
    _view!.play(action);
  }

  /// Jumps to another perch in reach; false if there is none.
  bool _leap() {
    final host = _host;
    if (host == null) return false;
    final view = _view!;
    final from = Offset(_x, _y);
    final power = view.figure.behavior.jumpPower;
    // Keep the whole arc on screen, with room for her take-off stretch.
    final ceiling = view.anchor.dy * 1.15;
    final options = <((Perch, Offset, Jump), double)>[];
    for (final perch in _scan(host)) {
      if (_perch != null && perch.sameSurface(_perch!)) continue;
      final span = perch.right - perch.left;
      final to = Offset(_rand(perch.left + span * 0.2, perch.right - span * 0.2), perch.y);
      final plan = planJump(from, to, power: power, ceiling: ceiling);
      if (plan == null) continue;
      final distance = (to - from).distance;
      final weight = (perch.preferred ? 3 : 1) * (perch.isFloor ? 0.35 : 1) / (1 + distance / 260);
      options.add(((perch, to, plan), weight));
    }
    final pick = weighted(options, _random);
    if (pick == null) return false;
    final (perch, to, plan) = pick;
    // Upward jumps that are a little too far end hanging from the edge.
    final hang = from.dy - to.dy > 110 && _random() < 0.25;
    // A long way down frightens her once she passes the top of the arc.
    final drop = to.dy - (math.min(from.dy, to.dy) - plan.apex);
    final fright = drop > view.height * 2.2 && view.figure.behavior.fallProp != 'umbrella';
    _face((to.dx - from.dx).sign);
    _flight = _Flight(from: from, plan: plan, target: perch, hang: hang, fright: fright);
    _mode = _Mode.jump;
    _perch = null;
    view.play(FigureState.jump);
    return true;
  }

  void _startFall({bool calm = false}) {
    _perch = null;
    _flight = null;
    _mode = _Mode.fall;
    _calmFall = calm;
    _view!.play(FigureState.fall);
  }

  void _land(Perch perch, double strength) {
    _perch = perch;
    _mode = _Mode.ground;
    _y = perch.y;
    _vx = _vy = 0;
    _flight = null;
    _x = _x.clamp(perch.left, perch.right);
    _view!.motion.land(strength);
    _action = FigureState.idle;
    _until = _clock / 1000 + (strength > 0.85 ? 1.8 : _rand(0.6, 1.4));
  }

  void _face(double direction) {
    if (direction != 0) _view!.setFacing(direction < 0 ? -1 : 1);
  }

  double _rand(double min, double max) => min + _random() * (max - min);

  // --------------------------------------------------------- interaction

  void _onPointer(PointerEvent event) => _pointer = event.localPosition;

  /// A lifted finger or stylus, or a mouse that left, is no longer near her.
  void _onPointerGone(PointerEvent event) {
    if (event is PointerUpEvent && event.kind == PointerDeviceKind.mouse) return;
    _pointer = null;
  }

  void _greet() {
    if (_mode != _Mode.ground) return;
    _lastGreet = _clock;
    final pointer = _pointer;
    if (pointer != null) _face(pointer.dx - _x == 0 ? 1 : (pointer.dx - _x).sign);
    _setAction(FigureState.wave, 1.7);
  }

  void _dragStart(DragStartDetails details) {
    if (_mode == _Mode.paused) return;
    _mode = _Mode.drag;
    _perch = null;
    _flight = null;
    _view!.play(FigureState.drag);
    _dragTo(details.globalPosition);
  }

  void _dragTo(Offset global) {
    final host = _host;
    if (host == null || _mode != _Mode.drag) return;
    // Held by the top of her head, inside the screen.
    final p = host.globalToLocal(global);
    final limits = _limits(host);
    final y = p.dy + _view!.height * 0.8;
    _x = limits == null ? p.dx : p.dx.clamp(limits.left, limits.right);
    _y = limits == null ? y : y.clamp(limits.top, limits.bottom);
  }

  void _dragEnd(Offset velocity) {
    if (_mode != _Mode.drag) return;
    // Let go mid-swing, she keeps flying the way she was thrown.
    _vx = velocity.dx.clamp(-_throwMax, _throwMax);
    _vy = velocity.dy.clamp(-_throwMax, _throwMax);
    _startFall();
  }

  @override
  Widget build(BuildContext context) {
    final view = _view;
    return PerchScope(
      registry: _registry,
      child: Listener(
        // Translucent: the host hears every pointer over it, even where no child hits.
        behavior: HitTestBehavior.translucent,
        onPointerHover: _onPointer,
        onPointerMove: _onPointer,
        onPointerDown: _onPointer,
        onPointerUp: _onPointerGone,
        onPointerCancel: _onPointerGone,
        // Opaque with translucent behavior reports exactly what its children hit, so the
        // host stays in the hit-test path (a non-opaque region always reports a miss).
        child: MouseRegion(
          hitTestBehavior: HitTestBehavior.translucent,
          onExit: _onPointerGone,
          child: Stack(
            key: _hostKey,
            fit: StackFit.expand,
            children: [
              widget.child,
              if (view != null && widget.visible && _mode != _Mode.paused)
                ListenableBuilder(
                  listenable: view,
                  builder: (context, child) {
                    final topLeft = _topLeft(view);
                    return Positioned(left: topLeft.dx, top: topLeft.dy, child: child!);
                  },
                  child: GestureDetector(
                    onTap: _greet,
                    onPanStart: _dragStart,
                    onPanUpdate: (details) => _dragTo(details.globalPosition),
                    onPanEnd: (details) => _dragEnd(details.velocity.pixelsPerSecond),
                    onPanCancel: () => _dragEnd(Offset.zero),
                    // Defer to the painted figure, so taps on transparent areas reach the app.
                    // (A non-opaque MouseRegion would also hide hits from the gesture detector.)
                    child: MouseRegion(
                      cursor: SystemMouseCursors.grab,
                      hitTestBehavior: HitTestBehavior.deferToChild,
                      child: FigureCanvas(controller: view),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
