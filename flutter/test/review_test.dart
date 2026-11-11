import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/peetty.dart';
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
    expect(state.position!.dy, 1300);
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
