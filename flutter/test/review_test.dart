import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/peetty.dart';
import 'package:peetty/src/peetty.dart' show overhangRows;
import 'package:peetty/src/rig.dart';

Map<String, Object?> _json(String id) => jsonDecode(File('assets/figures/$id.json').readAsStringSync()) as Map<String, Object?>;
final _miru = Figure.fromJson(_json('miru'));
final _koharu = Figure.fromJson(_json('koharu'));

double Function() _seeded([int seed = 3]) {
  var state = seed;
  return () {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

PeettyState _state(WidgetTester tester) => tester.state<PeettyState>(find.byType(Peetty));

Future<bool> _until(WidgetTester tester, bool Function() done, {int frames = 600}) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 16));
    if (done()) return true;
  }
  return false;
}

/// A minimal rig figure: one shape on the body bone.
Map<String, Object?> _tiny({Map<String, Object?>? shape, Map<String, Object?> extra = const {}}) => {
      'format': 'peetty.figure',
      'version': 1,
      'id': 'tiny',
      'name': 'Tiny',
      'renderer': 'rig',
      'viewBox': [0, 0, 100, 100],
      'height': 100,
      'anchor': [50, 100],
      'palette': {'ink': '#000000'},
      'skeleton': {for (final bone in Bone.values) bone.name: {'pivot': [50, 50]}},
      'parts': [
        {'id': 'p', 'bone': 'body', 'z': 0, 'shapes': [shape ?? {'type': 'ellipse', 'cx': 50, 'cy': 50, 'rx': 10, 'ry': 10, 'fill': 'ink'}]},
      ],
      ...extra,
    };

void main() {
  group('figure data', () {
    test('rejects wrongly typed fields as format errors', () {
      final data = _tiny();
      ((data['parts'] as List).first as Map)['clip'] = 3;
      expect(() => Figure.fromJson(data), throwsA(isA<FigureFormatException>()));
      expect(() => Figure.fromJson(_tiny(shape: {'type': 'ellipse', 'cx': 50, 'cy': 50, 'rx': 10, 'ry': 10, 'fill': 1})), throwsA(isA<FigureFormatException>()));
    });

    test('rejects empty gradients and oversized geometry', () {
      expect(
        () => Figure.fromJson(_tiny(extra: {
          'gradients': {'g': {'type': 'linear', 'from': [0, 0], 'to': [1, 1], 'stops': []}},
        })),
        throwsA(isA<FigureFormatException>()),
      );
      expect(() => Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0${' L1 1' * 5000}', 'fill': 'ink'})), throwsA(isA<FigureFormatException>()));
      final many = _tiny();
      many['parts'] = List.filled(201, (many['parts'] as List).first);
      expect(() => Figure.fromJson(many), throwsA(isA<FigureFormatException>()));
    });

    test('a clip is the union of its shapes, even with opposite winding', () {
      final figure = Figure.fromJson(_tiny(extra: {
        'clips': {
          'c': [
            {'type': 'path', 'd': 'M0 0 L60 0 L60 60 L0 60 Z'},
            {'type': 'path', 'd': 'M40 40 L40 100 L100 100 L100 40 Z'},
          ],
        },
      }));
      expect(figure.clips['c']!.contains(const Offset(50, 50)), isTrue);
    });
  });

  test('stroke-only shapes are hit where they are painted', () {
    final figure = Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M20 50 L80 50', 'stroke': 'ink', 'strokeWidth': 10}));
    final view = FigureController(figure)..step(0);
    expect(view.hitTest(const Offset(50, 52)), isTrue);
    expect(view.hitTest(const Offset(50, 70)), isFalse);
  });

  group('stroke hit testing', () {
    FigureController line(String d, {String cap = 'butt', String join = 'miter'}) => FigureController(Figure.fromJson(
          _tiny(shape: {'type': 'path', 'd': d, 'stroke': 'ink', 'strokeWidth': 10, 'lineCap': cap, 'lineJoin': join}),
        ))
          ..step(0);

    test('stays bounded for very long strokes', () {
      final view = line('M0 50 L1000000000 50');
      final watch = Stopwatch()..start();
      expect(view.hitTest(const Offset(50, 53)), isTrue);
      expect(view.hitTest(const Offset(50, 60)), isFalse);
      expect(watch.elapsedMilliseconds, lessThan(200));
    });

    test('matches butt, square and round caps', () {
      expect(line('M20 50 L80 50').hitTest(const Offset(78, 50)), isTrue);
      expect(line('M20 50 L80 50').hitTest(const Offset(83, 50)), isFalse);
      expect(line('M20 50 L80 50', cap: 'square').hitTest(const Offset(84, 54)), isTrue);
      expect(line('M20 50 L80 50', cap: 'round').hitTest(const Offset(84, 54)), isFalse);
      expect(line('M20 50 L80 50', cap: 'round').hitTest(const Offset(84, 50)), isTrue);
    });

    test('matches miter, bevel and round joins', () {
      const tip = Offset(50, 11);
      expect(line('M20 80 L50 20 L80 80').hitTest(tip), isTrue);
      expect(line('M20 80 L50 20 L80 80', join: 'bevel').hitTest(tip), isFalse);
      expect(line('M20 80 L50 20 L80 80', join: 'round').hitTest(tip), isFalse);
    });
  });

  test('large curved strokes are hit on the painted curve, not its chords', () {
    final rig = Rig(Figure.fromJson(_tiny(shape: {'type': 'ellipse', 'cx': 0, 'cy': 0, 'rx': 1000, 'ry': 1000, 'stroke': 'ink', 'strokeWidth': 1})));
    Offset at(double radius) => Offset.fromDirection(math.pi / 8, radius);
    expect(rig.hitTest(at(1000.3)), isTrue);
    expect(rig.hitTest(at(999.7)), isTrue);
    expect(rig.hitTest(at(1000.7)), isFalse);
    final vast = Rig(Figure.fromJson(_tiny(shape: {'type': 'ellipse', 'cx': 0, 'cy': 0, 'rx': 1e6, 'ry': 1e6, 'stroke': 'ink', 'strokeWidth': 1})));
    expect(vast.hitTest(at(1e6 + 0.3)), isTrue);
    expect(vast.hitTest(at(1e6 + 0.7)), isFalse);
    // A turned, flattened ellipse: offset along the outline's normal at parameter t.
    final turned = Rig(Figure.fromJson(_tiny(shape: {'type': 'ellipse', 'cx': 10, 'cy': 20, 'rx': 1000, 'ry': 300, 'rotate': 30, 'stroke': 'ink', 'strokeWidth': 1})));
    Offset normalAt(double t, double offset) {
      final r = math.pi / 6;
      final local = Offset(1000 * math.cos(t), 300 * math.sin(t));
      final n = Offset(300 * math.cos(t), 1000 * math.sin(t));
      final shifted = local + n / n.distance * offset;
      return Offset(10 + shifted.dx * math.cos(r) - shifted.dy * math.sin(r), 20 + shifted.dx * math.sin(r) + shifted.dy * math.cos(r));
    }
    for (final t in [0.3, 1.2, 2.5, 4.0]) {
      expect(turned.hitTest(normalAt(t, 0.4)), isTrue, reason: 'outside at $t');
      expect(turned.hitTest(normalAt(t, -0.4)), isTrue, reason: 'inside at $t');
      expect(turned.hitTest(normalAt(t, 0.8)), isFalse, reason: 'beyond at $t');
    }
    // A collinear curve that doubles back past its end still paints its whole run.
    final back = Rig(Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 50 C100 50 100 50 10 50', 'stroke': 'ink', 'strokeWidth': 2})));
    expect(back.hitTest(const Offset(50, 50)), isTrue);
    expect(back.hitTest(const Offset(90, 50)), isFalse);
    // A tiny reversal past the start is drawn too, within a butt-capped stroke.
    final tiny = Rig(Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0 C-.09 0 -.09 0 .01 0', 'stroke': 'ink', 'strokeWidth': 4, 'lineCap': 'butt'})));
    expect(tiny.hitTest(const Offset(-.04, 0)), isTrue);
    // A long, thin ellipse turned upright: points on its axis sit inside the stroke.
    final needle = Rig(Figure.fromJson(_tiny(shape: {'type': 'ellipse', 'cx': 0, 'cy': 0, 'rx': 100, 'ry': 1, 'rotate': 90, 'stroke': 'ink', 'strokeWidth': 2})));
    expect(needle.hitTest(const Offset(0, 0.5)), isTrue);
    expect(needle.hitTest(const Offset(0, 50)), isTrue);
    expect(needle.hitTest(const Offset(5, 50)), isFalse);
    final arc = Rig(Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0 C0 -2000 2000 -2000 2000 0', 'stroke': 'ink', 'strokeWidth': 1})));
    // The curve's top is at y = -1500 halfway along.
    expect(arc.hitTest(const Offset(1000, -1500.3)), isTrue);
    expect(arc.hitTest(const Offset(1000, -1501)), isFalse);
  });

  test('extreme coordinates never escape as non-format errors', () {
    expect(() => Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0 L1e999 0', 'stroke': 'ink'})), throwsA(isA<FigureFormatException>()));
    expect(() => Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0 C1e200 0 0 0 0 0', 'stroke': 'ink'})), throwsA(isA<FigureFormatException>()));
    expect(() => Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0 L2e9 0', 'stroke': 'ink'})), throwsA(isA<FigureFormatException>()));
    expect(() => Figure.fromJson(_tiny(shape: {'type': 'ellipse', 'cx': 0, 'cy': 0, 'rx': 2e9, 'ry': 1, 'stroke': 'ink'})), throwsA(isA<FigureFormatException>()));
    final huge = Rig(Figure.fromJson(_tiny(shape: {'type': 'path', 'd': 'M0 0 C1e9 0 0 0 0 0', 'stroke': 'ink', 'strokeWidth': 2})));
    expect(huge.hitTest(const Offset(10, 0)), isTrue);
    expect(huge.hitTest(const Offset(10, 50)), isFalse);
  });

  group('overhang rows without screen bounds', () {
    test('a rounding-sized overhang under an identity transform keeps every row', () {
      final overhang = (0.1 + 0.2) * 1000 - 300;
      expect(overhang, greaterThan(0));
      expect(overhangRows(Matrix4.identity(), 300, overhang, 600, 192), (0.0, 600.0));
    });

    test('a magnified overhang near a horizon leaves no rows', () {
      final transform = Matrix4.identity()
        ..setEntry(0, 0, 1e-7)
        ..setEntry(1, 1, 1e-7)
        ..setEntry(3, 0, -(1 - 1e-9));
      expect(overhangRows(transform, 1, 5e-10, 2, 1), isNull);
    });

    test('a narrow admissible run between widely spaced rows is still found', () {
      // X = 200·(y − 50), Y = x, W = 1 + 0.01·x: only rows near 10 to 90 of 51,200 qualify.
      final transform = Matrix4.identity()
        ..setEntry(0, 0, 0)
        ..setEntry(0, 1, 200)
        ..setEntry(0, 3, -10000)
        ..setEntry(1, 0, 1)
        ..setEntry(1, 1, 0)
        ..setEntry(3, 0, 0.01);
      final rows = overhangRows(transform, 100, 5e-8, 51200, 50)!;
      expect(rows.$1, closeTo(10, 0.01));
      expect(rows.$2, closeTo(90, 0.01));
    });

    test('only the rows where the overhang stays invisible are used', () {
      // W = 1 − (1 − 1e-9)·x + y: near y = 0 the overhang is magnified, lower down it is not.
      final transform = Matrix4.identity()
        ..setEntry(0, 0, 1e-7)
        ..setEntry(1, 1, 1e-7)
        ..setEntry(3, 0, -(1 - 1e-9))
        ..setEntry(3, 1, 1);
      final rows = overhangRows(transform, 1, 5e-10, 2, 1)!;
      expect(rows.$1, lessThanOrEqualTo(1));
      expect(rows.$1, greaterThan(0));
      expect(rows.$2, 2);
    });
  });

  test('enforces an aggregate geometry budget but accepts many small clips', () {
    final big = _tiny();
    final d = 'M0 0${' L1 1' * 3800}';
    final part = {'id': 'p', 'bone': 'body', 'z': 0, 'shapes': List.filled(64, {'type': 'path', 'd': d, 'fill': 'ink'})};
    big['parts'] = List.filled(9, part);
    expect(() => Figure.fromJson(big), throwsA(isA<FigureFormatException>()));
    final clips = _tiny(extra: {
      'clips': {
        for (var i = 0; i < 65; i++) 'c$i': [{'type': 'ellipse', 'cx': 50, 'cy': 50, 'rx': 5, 'ry': 5}],
      },
    });
    expect(Figure.fromJson(clips).clips, hasLength(65));
  });

  Widget host({required Widget child, Figure? figure, bool visible = true}) => Directionality(
        textDirection: TextDirection.ltr,
        child: Peetty(figureData: figure ?? _miru, random: _seeded(), visible: visible, child: child),
      );

  testWidgets('switching figures retires the old controller cleanly', (tester) async {
    await tester.pumpWidget(host(child: const SizedBox.expand()));
    await _until(tester, () => _state(tester).position != null, frames: 20);
    await tester.pumpWidget(host(child: const SizedBox.expand(), figure: _koharu));
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.takeException(), isNull);
    expect(_state(tester).figure?.id, 'koharu');
  });

  testWidgets('taps on transparent parts of her box reach the app', (tester) async {
    var taps = 0;
    await tester.pumpWidget(host(child: GestureDetector(onTap: () => taps++, child: const ColoredBox(color: Colors.white))));
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 600 && state.action == FigureState.idle), isTrue);
    final canvas = find.byType(FigureCanvas);
    final corner = tester.getTopLeft(canvas) + const Offset(2, 2);
    await tester.tapAt(corner);
    expect(taps, 1);
  });

  testWidgets('an offstage perch is never used', (tester) async {
    await tester.pumpWidget(host(
      child: const Stack(children: [
        Positioned(left: 300, top: 300, width: 240, height: 80, child: Offstage(child: PeettyPerch(child: SizedBox.expand()))),
      ]),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 600 && state.action != FigureState.fall), isTrue);
  });

  testWidgets('she rides along with a perch that moves sideways', (tester) async {
    Widget at(double left) => host(
          child: Stack(children: [
            Positioned(left: left, top: 400, width: 240, height: 80, child: const PeettyPerch(child: SizedBox.expand())),
          ]),
        );
    await tester.pumpWidget(at(300));
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 400 && state.action == FigureState.idle), isTrue);
    final before = state.position!.dx;
    await tester.pumpWidget(at(340));
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.position!.dx, closeTo(before + 40, 0.5));
  });

  testWidgets('safe-area insets apply only where they overlap the host', (tester) async {
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600), padding: EdgeInsets.only(bottom: 34)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Align(
          alignment: Alignment.topCenter,
          child: SizedBox(height: 400, child: Peetty(figureData: _miru, random: _seeded(), child: const SizedBox.expand())),
        ),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    expect(state.position!.dy, 400);
  });

  testWidgets('safe-area insets are measured in a scaled host', (tester) async {
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600), padding: EdgeInsets.only(bottom: 34)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 0,
            top: 300,
            width: 800,
            height: 400,
            // 800x400 at half scale: it ends at y = 500 on screen, clear of the inset.
            child: Transform.scale(
              scale: 0.5,
              alignment: Alignment.topLeft,
              child: Peetty(figureData: _miru, random: _seeded(), child: const SizedBox.expand()),
            ),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    expect(state.position!.dy, 400);
  });

  testWidgets('safe-area insets follow a rotated host', (tester) async {
    // 250x300 at (500, 100) turned 30°: wholly on an 800x600 screen with no insets.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 500,
            top: 100,
            width: 250,
            height: 300,
            child: Transform.rotate(
              angle: math.pi / 6,
              alignment: Alignment.topLeft,
              child: Peetty(
                figureData: _miru,
                random: _seeded(),
                child: const Stack(children: [
                  Positioned(left: 40, top: 150, width: 170, height: 40, child: PeettyPerch(child: SizedBox.expand())),
                ]),
              ),
            ),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    expect(state.position!.dy, 150);
  });

  testWidgets('safe-area insets apply to an upside-down host', (tester) async {
    // 400x600 turned 180° about its origin at screen (400, 600): its first rows meet the bottom inset.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600), padding: EdgeInsets.only(bottom: 34)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 400,
            top: 600,
            width: 400,
            height: 600,
            child: Transform.rotate(
              angle: math.pi,
              alignment: Alignment.topLeft,
              child: Peetty(
                figureData: _miru,
                random: _seeded(),
                child: const Stack(children: [
                  Positioned(left: 100, top: 140, width: 200, height: 40, child: PeettyPerch(child: SizedBox.expand())),
                ]),
              ),
            ),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    // With the 34-unit inset, a perch at row 140 leaves her head inside it, so she uses the floor.
    expect(state.position!.dy, 600);
  });

  testWidgets('safe-area insets apply to a sideways host as columns', (tester) async {
    // 600x400 turned 90° about its origin at screen (600, 0): host x runs down the screen,
    // so the 50-unit top inset covers its first 50 columns.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600), padding: EdgeInsets.only(top: 50)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 600,
            top: 0,
            width: 600,
            height: 400,
            child: Transform.rotate(
              angle: math.pi / 2,
              alignment: Alignment.topLeft,
              child: Peetty(
                figureData: _miru,
                random: _seeded(),
                child: const Stack(children: [
                  Positioned(left: 0, top: 300, width: 90, height: 40, child: PeettyPerch(child: SizedBox.expand())),
                ]),
              ),
            ),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    // The perch lies within the inset columns, so she uses the floor, clear of them.
    expect(state.position!.dy, 400);
    expect(state.position!.dx, greaterThanOrEqualTo(50));
  });

  testWidgets('a steeply tilted host whose rows overflow the safe band still has room', (tester) async {
    // 300x1300 at (700, 0) turned 60°: its height spans 650 screen units, more than the screen.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 700,
            top: 0,
            width: 300,
            height: 1300,
            child: Transform.rotate(
              angle: math.pi / 3,
              alignment: Alignment.topLeft,
              child: Peetty(figureData: _miru, random: _seeded(), child: const SizedBox.expand()),
            ),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    // She stands where her feet and head are both on screen, not on the far edge.
    final host = tester.renderObject<RenderBox>(find.descendant(of: find.byType(Peetty), matching: find.byType(Stack)).first);
    final feet = host.localToGlobal(state.position!);
    final head = host.localToGlobal(state.position! - Offset(0, tester.getSize(find.byType(FigureCanvas)).height * 0.9));
    for (final point in [feet, head]) {
      expect(point.dx, inInclusiveRange(0, 800), reason: '$point');
      expect(point.dy, inInclusiveRange(0, 600), reason: '$point');
    }
  });

  testWidgets('a wide host scrolled a pixel off screen still finds the narrow safe columns', (tester) async {
    // 1000 wide, one pixel left of a 200-wide screen, with a 150-wide figure: only
    // column starts 1 through 51 fit.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(200, 400)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: -1,
            top: 0,
            width: 1000,
            height: 400,
            child: Peetty(figureData: _miru, scale: 150 / (_miru.height * _miru.viewBox.width / _miru.viewBox.height), random: _seeded(), child: const SizedBox.expand()),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    final canvas = find.byType(FigureCanvas);
    expect(tester.getSize(canvas).width, closeTo(150, 0.01));
    expect(tester.getTopLeft(canvas).dx, greaterThanOrEqualTo(-1e-6));
    expect(tester.getTopRight(canvas).dx, lessThanOrEqualTo(200 + 1e-6));
  });

  testWidgets('a host under a perspective transform uses its projected size', (tester) async {
    // W = 1 + 0.005·x: a 250-wide figure at the left projects to about 111 pixels.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(200, 400)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 0,
            top: 0,
            width: 1000,
            height: 400,
            child: Transform(
              transform: Matrix4.identity()..setEntry(3, 0, 0.005),
              child: Peetty(
                figureData: _miru,
                scale: 250 / (_miru.height * _miru.viewBox.width / _miru.viewBox.height),
                random: _seeded(),
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ]),
      ),
    ));
    final state = _state(tester);
    expect(await _until(tester, () => state.action != FigureState.fall && state.position != null), isTrue);
    final canvas = tester.renderObject<RenderBox>(find.byType(FigureCanvas));
    for (final corner in [Offset.zero, Offset(canvas.size.width, 0), Offset(0, canvas.size.height * 0.9), Offset(canvas.size.width, canvas.size.height * 0.9)]) {
      final point = canvas.localToGlobal(corner);
      expect(point.dx, inInclusiveRange(-1e-6, 200 + 1e-6), reason: '$point');
      expect(point.dy, inInclusiveRange(-1e-6, 400 + 1e-6), reason: '$point');
    }
  });

  testWidgets('a very tall host that cannot fit her width on screen parks her', (tester) async {
    // At x = 610 on an 800-wide screen, a 200-wide figure always reaches x = 810.
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Stack(children: [
          Positioned(
            left: 610,
            top: 0,
            width: 400,
            height: 100000,
            child: Peetty(
              figureData: _miru,
              scale: 200 / (_miru.height * _miru.viewBox.width / _miru.viewBox.height),
              random: _seeded(),
              child: const SizedBox.expand(),
            ),
          ),
        ]),
      ),
    ));
    await _until(tester, () => false, frames: 60);
    expect(_state(tester).position, isNull);
  });

  Widget transformed(Matrix4 transform, Size host, double figureWidth) => MediaQuery(
        data: const MediaQueryData(size: Size(800, 600)),
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Stack(children: [
            Positioned(
              left: 0,
              top: 0,
              width: host.width,
              height: host.height,
              child: Transform(
                transform: transform,
                child: Peetty(
                  figureData: _miru,
                  scale: figureWidth / (_miru.height * _miru.viewBox.width / _miru.viewBox.height),
                  random: _seeded(),
                  child: const SizedBox.expand(),
                ),
              ),
            ),
          ]),
        ),
      );

  testWidgets('tiny row coefficients that add up over a tall host are not ignored', (tester) async {
    // X = x + 0.00005·y − 100,000,000 and Y = 0.006·y: a fit exists near x = 99,999,996, y = 90,000.
    final transform = Matrix4.identity()
      ..setEntry(0, 1, 0.00005)
      ..setEntry(0, 3, -100000000)
      ..setEntry(1, 1, 0.006);
    await tester.pumpWidget(transformed(transform, const Size(100000196, 100000), 200));
    // She finds somewhere to be rather than staying parked (the fall itself is long).
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNotNull);
  });

  testWidgets('tiny column coefficients that add up over a wide host are not ignored', (tester) async {
    // W = 0.0000011 and X = 610·W + 9e-13·x: a figure as wide as the host spans screen x 610 to 810.
    final transform = Matrix4.identity()
      ..setEntry(0, 0, 9e-13)
      ..setEntry(0, 3, 610 * 0.0000011)
      ..setEntry(1, 1, 0.0000011 * 1e-6)
      ..setEntry(3, 3, 0.0000011);
    await tester.pumpWidget(transformed(transform, const Size(244444445, 500000000), 244444444));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNull);
    // The same host with 8e-13 spans 610 to about 788, which fits.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(transformed(transform.clone()..setEntry(0, 0, 8e-13), const Size(244444445, 500000000), 244444444));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNotNull);
  });

  testWidgets('rounding slack never admits a box that projects off screen', (tester) async {
    // W = 1e-8 + 0.001·x, X = 810·W + 0.02·x, Y = 300·W + 0.02·y: every point projects to x ≥ 810.
    final transform = Matrix4.identity()
      ..setEntry(0, 0, 810 * 0.001 + 0.02)
      ..setEntry(0, 3, 810 * 1e-8)
      ..setEntry(1, 0, 300 * 0.001)
      ..setEntry(1, 1, 0.02)
      ..setEntry(1, 3, 300 * 1e-8)
      ..setEntry(3, 0, 0.001)
      ..setEntry(3, 3, 1e-8);
    await tester.pumpWidget(transformed(transform, const Size(100000, 300), 0.00003));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNull);
  });

  testWidgets('a huge host shifted off screen still finds an on-screen start', (tester) async {
    // 2,000,000 wide, 100 to the left of an 800x600 screen, with a 200-wide figure.
    await tester.pumpWidget(transformed(Matrix4.translationValues(-100, 0, 0), const Size(2000000, 600), 200));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNotNull);
  });

  testWidgets('a sheared host finds the start where she fits, not the middle', (tester) async {
    // X = x − 100 and Y = y + 0.5·(x − 100): only starts near x = 100 leave her enough rows.
    final transform = Matrix4.identity()
      ..setEntry(0, 3, -100)
      ..setEntry(1, 0, 0.5)
      ..setEntry(1, 3, -50);
    // A figure needing about 400 rows: only starts within about 88 of x = 100 fit.
    await tester.pumpWidget(transformed(transform, const Size(2000000, 600), 312.5));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNotNull);
  });

  testWidgets('a figure exactly as wide as the safe area survives rounding', (tester) async {
    // X = 3·x + 498.8: a 100.4-wide host and figure reach screen x = 800 exactly.
    final transform = Matrix4.identity()
      ..setEntry(0, 0, 3)
      ..setEntry(0, 3, 498.8);
    await tester.pumpWidget(transformed(transform, const Size(100.4, 600), 100.4));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNotNull);
  });

  testWidgets('rounding allowance never lets her overhang a tiny host', (tester) async {
    // A 5e-10-wide host shown 1e12 times wider, with an 8e-10-wide figure: 300 pixels too wide.
    // Vertically 1e11 times taller, so her height alone would fit.
    await tester.pumpWidget(transformed(Matrix4.diagonal3Values(1e12, 1e11, 1), const Size(5e-10, 5e-9), 8e-10));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNull);
  });

  testWidgets('a host-unit rounding overhang magnified near a horizon is rejected', (tester) async {
    // W = 1 − (1 − 1e-9)·x and X = 1e-7·x: the host's right edge lands near screen x = 100,
    // a figure 5e-10 wider reaches about x = 200.
    final transform = Matrix4.identity()
      ..setEntry(0, 0, 1e-7)
      ..setEntry(1, 1, 1e-7)
      ..setEntry(3, 0, -(1 - 1e-9));
    // Tall enough (2 units, about 200 pixels near the edge) that her height fits.
    await tester.pumpWidget(transformed(transform, const Size(1, 2), 1 + 5e-10));
    await _until(tester, () => false, frames: 30);
    expect(_state(tester).position, isNull);
  });

  testWidgets('a host too short for her below a large inset leaves her nowhere to stand', (tester) async {
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(size: Size(800, 600), padding: EdgeInsets.only(top: 80)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Align(
          alignment: Alignment.topCenter,
          child: SizedBox(height: 150, child: Peetty(figureData: _miru, random: _seeded(), child: const SizedBox.expand())),
        ),
      ),
    ));
    await _until(tester, () => false, frames: 60);
    expect(_state(tester).position, isNull);
  });

  testWidgets('pointer events reach the host over children that do not hit-test', (tester) async {
    await tester.pumpWidget(host(child: const SizedBox.expand()));
    await tester.pump();
    final path = tester.hitTestOnBinding(const Offset(20, 20)).path.map((e) => e.target).toList();
    expect(path, contains(tester.renderObject(find.descendant(of: find.byType(Peetty), matching: find.byType(Listener)).first)));
  });

  testWidgets('the host reports what its children hit, keeping siblings below out', (tester) async {
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(children: [
        const ColoredBox(key: ValueKey('below'), color: Colors.black, child: SizedBox.expand()),
        Peetty(figureData: _miru, random: _seeded(), child: const ColoredBox(color: Colors.white, child: SizedBox.expand())),
      ]),
    ));
    await tester.pump();
    final path = tester.hitTestOnBinding(const Offset(20, 20)).path.map((e) => e.target).toList();
    final listener = tester.renderObject(find.descendant(of: find.byType(Peetty), matching: find.byType(Listener)).first);
    expect(path, contains(listener));
    expect(path, isNot(contains(tester.renderObject(find.byKey(const ValueKey('below'))))));
  });

  testWidgets('a hidden companion schedules no frames', (tester) async {
    await tester.pumpWidget(host(child: const SizedBox.expand()));
    await _until(tester, () => _state(tester).position != null, frames: 20);
    await tester.pumpWidget(host(child: const SizedBox.expand(), visible: false));
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.binding.transientCallbackCount, 0);
    await tester.pumpWidget(host(child: const SizedBox.expand()));
    expect(await _until(tester, () => _state(tester).position != null), isTrue);
  });

  testWidgets('loads bundled figures through a custom asset bundle', (tester) async {
    final bundle = _FileBundle();
    await tester.pumpWidget(DefaultAssetBundle(
      bundle: bundle,
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Peetty(figure: 'koharu', random: _seeded(), child: const SizedBox.expand()),
      ),
    ));
    final state = _state(tester);
    for (var i = 0; i < 20 && state.figure == null; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect(tester.takeException(), isNull);
    expect(bundle.requested, contains('packages/peetty/assets/figures/koharu.json'));
    expect(state.figure?.id, 'koharu');
  });
}

class _FileBundle extends CachingAssetBundle {
  final requested = <String>[];

  @override
  Future<ByteData> load(String key) async {
    requested.add(key);
    final bytes = File(key.replaceFirst('packages/peetty/', '')).readAsBytesSync();
    return ByteData.sublistView(Uint8List.fromList(bytes));
  }
}
