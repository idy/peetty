import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/peetty.dart';

final _miru = Figure.fromJson(jsonDecode(File('assets/figures/miru.json').readAsStringSync()));

double Function() _seeded([int seed = 3]) {
  var state = seed;
  return () {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/// A 800x600 screen with one card whose top edge is at y = 400.
Widget _app({bool perch = true, PeettyActivity activity = PeettyActivity.calm}) => Directionality(
      textDirection: TextDirection.ltr,
      child: Peetty(
        figureData: _miru,
        random: _seeded(),
        activity: activity,
        child: Stack(children: [
          Positioned(
            left: 300,
            top: 400,
            width: 240,
            height: 80,
            child: perch ? const PeettyPerch(child: ColoredBox(color: Colors.amber)) : const ColoredBox(color: Colors.amber),
          ),
        ]),
      ),
    );

PeettyState _state(WidgetTester tester) => tester.state<PeettyState>(find.byType(Peetty));

/// Pumps frames until [done] or the time runs out; returns whether it happened.
Future<bool> _until(WidgetTester tester, bool Function() done, {int frames = 600}) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 16));
    if (done()) return true;
  }
  return false;
}

void main() {
  testWidgets('she drops in onto a perch', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pump();
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 400), isTrue, reason: 'landed at ${state.position}');
    final x = state.position!.dx;
    expect(x, inInclusiveRange(300, 540));
    expect(find.byType(FigureCanvas), findsOneWidget);
  });

  testWidgets('she falls to the floor when her perch goes away', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pump();
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 400), isTrue);
    await tester.pumpWidget(_app(perch: false));
    expect(await _until(tester, () => state.position?.dy == 600), isTrue, reason: 'ended at ${state.position}');
  });

  testWidgets('she can be picked up and thrown', (tester) async {
    await tester.pumpWidget(_app());
    await tester.pump();
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 400 && state.action == FigureState.idle), isTrue);
    final feet = state.position!;
    final figure = find.byType(FigureCanvas);
    final body = tester.getTopLeft(figure) + Offset(tester.getSize(figure).width / 2, tester.getSize(figure).height * 0.55);
    final gesture = await tester.startGesture(body);
    await gesture.moveBy(const Offset(0, -20));
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.action, FigureState.drag);
    for (var i = 0; i < 5; i++) {
      await gesture.moveBy(const Offset(-30, -20));
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(state.position!.dx, lessThan(feet.dx));
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.action, FigureState.fall);
    expect(await _until(tester, () => state.action != FigureState.fall), isTrue);
    expect(state.position!.dy, anyOf(400, 600));
  });

  testWidgets('taps on empty space go through to the app', (tester) async {
    var taps = 0;
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Peetty(
        figureData: _miru,
        random: _seeded(),
        child: GestureDetector(onTap: () => taps++, child: const ColoredBox(color: Colors.white)),
      ),
    ));
    await tester.pump();
    await _until(tester, () => _state(tester).position?.dy == 600);
    await tester.tapAt(const Offset(20, 20));
    expect(taps, 1);
  });

  testWidgets('loads a bundled figure by id', (tester) async {
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Peetty(figure: 'koharu', random: _seeded(), child: const SizedBox.expand()),
    ));
    final state = _state(tester);
    for (var i = 0; i < 20 && state.figure == null; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect(state.figure?.id, 'koharu');
  });

  testWidgets('a perch scrolled out of view is not used', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Peetty(
        figureData: _miru,
        random: _seeded(),
        child: ListView(controller: controller, children: [
          const SizedBox(height: 300),
          const PeettyPerch(child: SizedBox(height: 100)),
          const SizedBox(height: 2000),
        ]),
      ),
    ));
    await tester.pump();
    final state = _state(tester);
    expect(await _until(tester, () => state.position?.dy == 300), isTrue);
    // Scrolling carries her along with the perch.
    controller.jumpTo(50);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.position!.dy, 250);
    // Once its top edge leaves the viewport she falls.
    controller.jumpTo(400);
    expect(await _until(tester, () => state.position?.dy == 600), isTrue);
  });
}
