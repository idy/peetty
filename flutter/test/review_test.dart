import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/peetty.dart';

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
