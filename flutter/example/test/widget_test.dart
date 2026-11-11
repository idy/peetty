import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/peetty.dart';
import 'package:peetty_example/main.dart';

void main() {
  testWidgets('the demo loads a companion that lands somewhere', (tester) async {
    await tester.pumpWidget(const PeettyDemo());
    final state = tester.state<PeettyState>(find.byType(Peetty));
    for (var i = 0; i < 20 && state.figure == null; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect(state.figure?.id, 'miru');
    var landed = false;
    for (var i = 0; i < 300 && !landed; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      landed = state.position != null && state.action != FigureState.fall;
    }
    expect(landed, isTrue);
  });
}
