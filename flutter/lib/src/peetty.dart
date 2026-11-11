import 'dart:math' as math;

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'figure.dart';
import 'figure_view.dart';
import 'perch.dart';
import 'physics.dart';

/// The longest run of host rows, at least [need] tall, where a figure overhanging
/// the host's right [edge] by [overhang] host units projects to at most a
/// millionth of a pixel past it, in front of the viewer; null when there is none.
///
/// Along a row the projection `(X/W, Y/W)` moves from the edge by exactly
/// `overhang · |(xx·Wa − wx·Xa, yx·Wa − wx·Ya)| / (Wa·Wb)`, with `Wa`, `Xa`, `Ya`
/// taken at the edge and `Wb = Wa + wx·overhang`. Near the horizon `Wa` is a tiny
/// difference of large terms, so rows are measured by `t = Wa` itself whenever
/// `Wa` varies by row: every factor is then linear in `t` with coefficients free
/// of that cancellation. Admissibility is tested on the factored form, and its
/// boundaries are roots of the squared inequality (a quartic in `t`) or of the
/// weights, isolated between the roots of its derivatives and bisected.
@visibleForTesting
(double, double)? overhangRows(Matrix4 transform, double edge, double overhang, double height, double need) {
  final m = transform.storage;
  final (xx, xy, xc) = (m[0], m[4], m[12]);
  final (yx, yy, yc) = (m[1], m[5], m[13]);
  final (wx, wy, wc) = (m[3], m[7], m[15]);
  const tolerance = 1e-6;
  final delta = wx * overhang; // Wb − Wa, computed directly.
  final base = wx * edge + wc; // Wa on row 0.

  // Each quantity as [constant, slope] in the variable t, and y as a function of t.
  final List<double> wa, xa, ya;
  final double Function(double t) rowOf;
  final double t0, t1;
  if (wy != 0) {
    wa = [0, 1];
    xa = [xx * edge + xc - xy * base / wy, xy / wy];
    ya = [yx * edge + yc - yy * base / wy, yy / wy];
    rowOf = (t) => (t - base) / wy;
    final (a, b) = (base, wy * height + base);
    (t0, t1) = a <= b ? (a, b) : (b, a);
  } else {
    wa = [base, 0];
    xa = [xx * edge + xc, xy];
    ya = [yx * edge + yc, yy];
    rowOf = (t) => t;
    (t0, t1) = (0, height);
  }
  final wb = [wa[0] + delta, wa[1]];
  final nx = [xx * wa[0] - wx * xa[0], xx * wa[1] - wx * xa[1]];
  final ny = [yx * wa[0] - wx * ya[0], yx * wa[1] - wx * ya[1]];

  // Factored, so no large terms cancel: Wa, Wb, Nx and Ny are each one linear term.
  bool ok(double t) {
    final a = _evaluate(wa, t), b = _evaluate(wb, t);
    if (a <= 0 || b <= 0) return false;
    final x = _evaluate(nx, t), y = _evaluate(ny, t);
    return overhang * math.sqrt(x * x + y * y) <= tolerance * a * b;
  }

  final ab = _multiply(wa, wb);
  final margin = _subtract(
    _scale(_multiply(ab, ab), tolerance * tolerance),
    _scale(_add(_multiply(nx, nx), _multiply(ny, ny)), overhang * overhang),
  );
  final cuts = <double>{t0, t1, ..._roots(margin, t0, t1), ..._roots(wa, t0, t1), ..._roots(wb, t0, t1)}.toList()..sort();
  (double, double)? best;
  double? start;
  void close(double end) {
    if (start != null) {
      final (r0, r1) = (rowOf(start!), rowOf(end));
      final rows = r0 <= r1 ? (r0, r1) : (r1, r0);
      final clamped = (rows.$1.clamp(0.0, height).toDouble(), rows.$2.clamp(0.0, height).toDouble());
      if (clamped.$2 - clamped.$1 >= need && (best == null || clamped.$2 - clamped.$1 > best!.$2 - best!.$1)) best = clamped;
    }
    start = null;
  }

  // Between consecutive boundaries every row is admissible or none is.
  for (var i = 0; i + 1 < cuts.length; i++) {
    if (ok((cuts[i] + cuts[i + 1]) / 2)) {
      start ??= cuts[i];
    } else {
      close(cuts[i]);
    }
  }
  close(t1);
  return best;
}

double _evaluate(List<double> p, double y) {
  var value = 0.0;
  for (var i = p.length - 1; i >= 0; i--) {
    value = value * y + p[i];
  }
  return value;
}

List<double> _multiply(List<double> a, List<double> b) {
  final out = List.filled(a.length + b.length - 1, 0.0);
  for (var i = 0; i < a.length; i++) {
    for (var j = 0; j < b.length; j++) {
      out[i + j] += a[i] * b[j];
    }
  }
  return out;
}

List<double> _add(List<double> a, List<double> b) =>
    [for (var i = 0; i < math.max(a.length, b.length); i++) (i < a.length ? a[i] : 0.0) + (i < b.length ? b[i] : 0.0)];

List<double> _scale(List<double> a, double k) => [for (final c in a) c * k];

List<double> _subtract(List<double> a, List<double> b) => _add(a, _scale(b, -1));

/// The real roots of [p] in (lo, hi): between consecutive roots of its derivative
/// a polynomial is monotone, so each sign change there is bisected.
List<double> _roots(List<double> p, double lo, double hi) {
  if (p.length < 2) return const [];
  final derivative = [for (var i = 1; i < p.length; i++) p[i] * i];
  final points = [lo, ..._roots(derivative, lo, hi), hi];
  final roots = <double>[];
  for (var i = 0; i + 1 < points.length; i++) {
    var a = points[i], b = points[i + 1];
    var fa = _evaluate(p, a);
    final fb = _evaluate(p, b);
    if (fa == 0 && a > lo) roots.add(a);
    if (fa.sign * fb.sign >= 0) continue;
    for (var k = 0; k < 200 && b - a > 0; k++) {
      final mid = a + (b - a) / 2;
      if (mid <= a || mid >= b) break;
      final fm = _evaluate(p, mid);
      if (fm.sign == fa.sign) {
        a = mid;
        fa = fm;
      } else {
        b = mid;
      }
    }
    roots.add((a + b) / 2);
  }
  return roots;
}

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

  /// Where her feet may be so that all of her, from her feet up, stays inside
  /// both the host and the screen's safe area; null when nowhere fits.
  ///
  /// Screen coordinates are affine in host coordinates, so for a scaled, rotated,
  /// skewed or flipped host the safe area is a slanted region of the host. Her
  /// limits are an axis-aligned box in host coordinates. For a column range, the
  /// rows keeping the whole box inside the safe area are solved exactly; their
  /// height is concave in where the columns start, so the best start is found by
  /// ternary search rather than sampling, and the largest fitting box wins.
  Limits? _limits(RenderBox host) {
    final view = _view!;
    final size = host.size;
    final screen = _screen;
    final transform = host.getTransformTo(null);
    final key = (transform.storage.join(','), size, screen, _padding, view.width, view.anchor);
    if (key == _limitsKey) return _limitsCache;
    _limitsKey = key;
    return _limitsCache = _solveLimits(transform, size, screen, view.width, view.anchor);
  }

  Object? _limitsKey;
  Limits? _limitsCache;

  Limits? _solveLimits(Matrix4 transform, Size size, Size? screen, double figureWidth, Offset anchor) {
    // Rounding can leave a box exactly her size a hair narrower than her: no span is still a place to stand.
    Limits box(double x0, double x1, double y0, double y1) {
      final left = x0 + anchor.dx, top = y0 + anchor.dy;
      return Limits(left, math.max(left, x1 - (figureWidth - anchor.dx)), top, math.max(top, y1));
    }
    // Rounding in host units, relative to the host: bounds that cross by less than
    // this still meet. It never admits more than a billionth of the host's width.
    final rounding = 1e-9 * size.width;
    if (size.width - figureWidth < -rounding) return null;
    if (screen == null) {
      // No screen to check against (a View always provides one, so this is a
      // fallback). A figure wider than the host only by rounding may stand on
      // the rows where that overhang projects to under a millionth of a pixel.
      if (size.height < anchor.dy) return null;
      final overhang = figureWidth - size.width;
      if (overhang <= 0) return box(0, size.width, 0, size.height);
      final rows = overhang > rounding ? null : overhangRows(transform, size.width, overhang, size.height, anchor.dy);
      return rows == null ? null : box(0, size.width, rows.$1, rows.$2);
    }
    // A host point (x, y) lands on screen at (X/W, Y/W), each of X, Y and W linear
    // in x and y, so perspective is covered too. Where W > 0 a screen bound such as
    // X/W ≥ left is the half-plane X − left·W ≥ 0, and a box satisfies a half-plane
    // exactly when its corners do. Each entry is (hx, hy, hc): hx·x + hy·y + hc ≥ 0.
    final m = transform.storage;
    final (xx, xy, xc) = (m[0], m[4], m[12]);
    final (yx, yy, yc) = (m[1], m[5], m[13]);
    final (wx, wy, wc) = (m[3], m[7], m[15]);
    final left = _padding.left, right = screen.width - _padding.right;
    final top = _padding.top, bottom = screen.height - _padding.bottom;
    final planes = [
      (xx - left * wx, xy - left * wy, xc - left * wc),
      (right * wx - xx, right * wy - xy, right * wc - xc),
      (yx - top * wx, yy - top * wy, yc - top * wc),
      (bottom * wx - yx, bottom * wy - yy, bottom * wc - yc),
      // In front of the viewer: past the horizon, projection flips.
      (wx, wy, wc - 1e-12 * (wx.abs() * size.width + wy.abs() * size.height + wc.abs())),
    ];

    // Half-planes that rows do not move constrain the columns alone; they are hard
    // limits on where columns may start, handled apart from the rest.
    // Only an exactly zero row coefficient is level: any other, however small, can
    // add up across a tall host, so it is solved for like the rest.
    bool flat((double, double, double) h) => h.$2 == 0;
    final sloped = [for (final h in planes) if (!flat(h)) h];
    final level = [for (final h in planes) if (flat(h)) h];

    // For columns [x0, x0 + width]: the rows [y0, y1] keeping the whole box inside
    // the sloped half-planes, and their height (negative when none fit). Every
    // bound is linear in x0, so the height is concave in x0.
    (double, double, double) rows(double x0, double width) {
      final x1 = x0 + width;
      var y0 = 0.0, y1 = size.height;
      for (final (hx, hy, hc) in sloped) {
        // The weakest corner column: hy·y ≥ need for every row of the box.
        final need = -hc - math.min(hx * x0, hx * x1);
        if (hy > 0) {
          y0 = math.max(y0, need / hy);
        } else {
          y1 = math.min(y1, need / hy);
        }
      }
      return (y0, y1, y1 - y0);
    }

    // Where columns of this width may start under the level half-planes, as an
    // interval within the host; null when nowhere.
    (double, double)? starts(double width) {
      var lo = 0.0, hi = math.max(0.0, size.width - width);
      for (final (hx, _, hc) in level) {
        // A constant bound, which no start can change, gets a rounding allowance.
        final slack = 1e-12 * hc.abs();
        if (hx == 0) {
          if (-hc > slack) return null;
        } else if (hx > 0) {
          lo = math.max(lo, -hc / hx);
        } else {
          hi = math.min(hi, (hc + hx * width) / -hx);
        }
      }
      if (lo <= hi) return (lo, hi);
      // Bounds that cross only by rounding meet at one start; the on-screen check
      // then decides, with its pixel tolerance, whether the box really fits. The
      // ends are never widened, so they stay valid starts themselves.
      if (lo - hi > rounding) return null;
      final start = ((lo + hi) / 2).clamp(0.0, math.max(0.0, size.width - width)).toDouble();
      return (start, start);
    }

    // The solve works in host units, where rounding adds up; the box it picks must still land inside
    // the safe area on screen, checked at its projected corners to within a
    // millionth of a logical pixel.
    bool onScreen(double x0, double x1, double y0, double y1) {
      for (final (x, y) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]) {
        if (wx * x + wy * y + wc <= 0) return false;
        final p = MatrixUtils.transformPoint(transform, Offset(x, y));
        // Inside the host too: any overhang past its edge is measured on screen,
        // where the transform cannot magnify a host-unit allowance.
        final cx = x.clamp(0.0, size.width).toDouble(), cy = y.clamp(0.0, size.height).toDouble();
        if (cx != x || cy != y) {
          if (wx * cx + wy * cy + wc <= 0) return false;
          if ((MatrixUtils.transformPoint(transform, Offset(cx, cy)) - p).distance > 1e-6) return false;
        }
        if (!(p.dx >= left - 1e-6 && p.dx <= right + 1e-6 && p.dy >= top - 1e-6 && p.dy <= bottom + 1e-6)) return false;
      }
      return true;
    }

    // The column start giving the most rows, by ternary search on the concave
    // height within the allowed starts; null when no start is allowed.
    double? bestStart(double width) {
      final range = starts(width);
      if (range == null) return null;
      var (lo, hi) = range;
      final (first, last) = range;
      for (var i = 0; i < 100 && hi - lo > 1e-9; i++) {
        final m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (rows(m1, width).$3 < rows(m2, width).$3) {
          lo = m1;
        } else {
          hi = m2;
        }
      }
      final mid = (lo + hi) / 2;
      // Plateaus can leave either end as good as the middle. Prefer the middle on
      // ties, as the ends may sit a rounding hair past a screen edge, and take the
      // tallest start whose box actually lands on screen.
      // On a flat stretch the search drifts to one end, so the range's own middle is tried too.
      final candidates = [mid, (first + last) / 2, first, last]..sort((a, b) => rows(b, width).$3.compareTo(rows(a, width).$3));
      for (final x0 in candidates) {
        final (y0, y1, _) = rows(x0, width);
        if (onScreen(x0, x0 + width, y0, y1)) return x0;
      }
      return candidates.first;
    }

    bool fits(double width) {
      final x0 = bestStart(width);
      if (x0 == null) return false;
      final (y0, y1, height) = rows(x0, width);
      return height >= anchor.dy && onScreen(x0, x0 + width, y0, y1);
    }

    // Narrower columns only loosen the constraints, so if anything fits her own
    // width does, and the widths that fit form a range: find its widest end.
    if (!fits(figureWidth)) return null;
    var narrow = figureWidth, wide = size.width;
    if (!fits(wide)) {
      for (var i = 0; i < 60 && wide - narrow > 1e-6; i++) {
        final mid = (narrow + wide) / 2;
        if (fits(mid)) {
          narrow = mid;
        } else {
          wide = mid;
        }
      }
      wide = narrow;
    }
    // Within that range, prefer the box with the most area.
    Limits? best;
    var bestArea = -1.0;
    for (final fraction in const [1.0, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12, 0.06, 0.0]) {
      final width = figureWidth + (wide - figureWidth) * fraction;
      final x0 = bestStart(width);
      if (x0 == null) continue;
      final (y0, y1, height) = rows(x0, width);
      if (height < anchor.dy || !onScreen(x0, x0 + width, y0, y1)) continue;
      final area = width * height;
      if (area > bestArea) {
        bestArea = area;
        best = box(x0, x0 + width, y0, y1);
      }
    }
    return best;
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
