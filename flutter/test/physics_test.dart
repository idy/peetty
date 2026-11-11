import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/src/physics.dart';

class _Edge implements Edge {
  const _Edge(this.left, this.right, this.y);
  @override
  final double left, right, y;
}

void main() {
  group('planJump', () {
    test('lands exactly on the target, up or down', () {
      for (final (from, to) in const [
        (Offset(100, 500), Offset(320, 380)),
        (Offset(400, 300), Offset(150, 560)),
        (Offset(200, 400), Offset(260, 400)),
      ]) {
        final plan = planJump(from, to)!;
        final end = along(from, plan, plan.duration);
        expect((end - to).distance, lessThan(0.01), reason: '$from -> $to');
      }
    });

    test('clears the higher point by its apex', () {
      const from = Offset(0, 500);
      final plan = planJump(from, const Offset(200, 400))!;
      var top = double.infinity;
      for (var t = 0.0; t <= plan.duration; t += 0.005) {
        final y = along(from, plan, t).dy;
        if (y < top) top = y;
      }
      expect((400 - top - plan.apex).abs(), lessThan(2));
    });

    test('refuses targets out of reach and allows more with power', () {
      expect(planJump(const Offset(0, 800), const Offset(100, 300)), isNull);
      expect(planJump(const Offset(0, 400), const Offset(700, 400)), isNull);
      expect(planJump(const Offset(0, 800), const Offset(100, 500), power: 1.2), isNotNull);
    });

    test('flattens the arc under a ceiling and refuses one that would scrape it', () {
      const from = Offset(0, 400);
      final free = planJump(from, const Offset(200, 400))!;
      final capped = planJump(from, const Offset(200, 400), ceiling: 380)!;
      expect(capped.apex, lessThan(free.apex));
      expect(along(from, capped, -capped.vy / gravity).dy, closeTo(380, 1e-6));
      expect((along(from, capped, capped.duration) - const Offset(200, 400)).distance, lessThan(0.01));
      expect(planJump(from, const Offset(200, 400), ceiling: 395), isNull);
    });
  });

  group('landing', () {
    const edges = [_Edge(0, 100, 200), _Edge(0, 100, 260), _Edge(200, 300, 150)];

    test('finds the first edge crossed under the body', () {
      expect(landing(edges, 50, 190, 270)?.y, 200);
      expect(landing(edges, 50, 205, 270)?.y, 260);
    });

    test('falls past the perch she just left', () {
      expect(landing(edges, 50, 200, 200.4), isNull);
      expect(landing(edges, 50, 200, 270)?.y, 260);
    });

    test('ignores edges not under her or not crossed this frame', () {
      expect(landing(edges, 150, 0, 400), isNull);
      expect(landing(edges, 250, 160, 200), isNull);
    });
  });

  test('impact scales with fall speed', () {
    expect(impact(0), 0);
    expect(impact(99999), 1);
  });

  test('weighted picks by weight and skips zero weights', () {
    expect(weighted([('a', 0.0), ('b', 1.0)], () => 0.99), 'b');
    expect(weighted([('a', 1.0), ('b', 3.0)], () => 0.1), 'a');
    expect(weighted(<(String, double)>[]), isNull);
  });
}
