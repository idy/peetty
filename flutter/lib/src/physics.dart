import 'dart:math' as math;
import 'dart:ui';

/// Pure movement helpers in logical pixels (y grows downward), ported from
/// the web SDK (`src/pet/physics.ts`).

const gravity = 2600.0;

/// Fall speed (px/s) that counts as a full-strength landing.
const hardLanding = 1500.0;

/// The flattest arc worth jumping; anything lower would scrape the ceiling.
const _minApex = 12.0;

class Jump {
  const Jump({required this.vx, required this.vy, required this.duration, required this.apex});
  final double vx;
  final double vy;
  final double duration;

  /// Height of the arc's top above the higher of the two points.
  final double apex;
}

/// Plans a ballistic jump that lands exactly on [to]. Returns null when the
/// target is out of reach for this jump [power], or when even a low arc would
/// rise above [ceiling], the smallest y the jumper may reach.
Jump? planJump(Offset from, Offset to, {double power = 1, double ceiling = double.negativeInfinity}) {
  final dx = to.dx - from.dx;
  final top = math.min(from.dy, to.dy);
  final double apex = math.min(36 + math.min(80.0, dx.abs() * 0.14), top - ceiling);
  if (apex < _minApex) return null;
  final peak = top - apex;
  final rise = from.dy - peak;
  if (rise > 360 * power || dx.abs() > 440 * power) return null;
  final vy = -math.sqrt(2 * gravity * rise);
  final up = -vy / gravity;
  final down = math.sqrt((2 * (to.dy - peak)) / gravity);
  final duration = up + down;
  return Jump(vx: dx / duration, vy: vy, duration: duration, apex: apex);
}

/// Position along a planned jump after [t] seconds.
Offset along(Offset from, Jump jump, double t) =>
    Offset(from.dx + jump.vx * t, from.dy + jump.vy * t + 0.5 * gravity * t * t);

/// A horizontal edge she can stand on.
abstract interface class Edge {
  double get left;
  double get right;
  double get y;
}

/// The first edge a falling body crosses between two frames, if any. Only
/// edges under the body's x count; the highest crossed edge wins.
T? landing<T extends Edge>(Iterable<T> edges, double x, double fromY, double toY) {
  T? best;
  for (final edge in edges) {
    if (x < edge.left || x > edge.right) continue;
    // An edge at or above the starting point was not crossed this frame.
    if (edge.y <= fromY || edge.y > toY) continue;
    if (best == null || edge.y < best.y) best = edge;
  }
  return best;
}

/// Landing strength 0..1 from the vertical speed at impact.
double impact(double vy) => (vy / hardLanding).clamp(0.0, 1.0);

/// Picks a value by relative weight; null when no weight is positive.
T? weighted<T>(Iterable<(T, double)> weights, [double Function()? random]) {
  final entries = [
    for (final entry in weights)
      if (entry.$2.isFinite && entry.$2 > 0) entry,
  ];
  final total = entries.fold<double>(0, (sum, e) => sum + e.$2);
  if (total == 0) return null;
  var remaining = (random ?? math.Random().nextDouble)() * total;
  for (final (value, weight) in entries) {
    remaining -= weight;
    if (remaining <= 0) return value;
  }
  return entries.last.$1;
}
