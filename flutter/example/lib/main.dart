import 'package:flutter/material.dart';
import 'package:peetty/peetty.dart';

void main() => runApp(const PeettyDemo());

class PeettyDemo extends StatefulWidget {
  const PeettyDemo({super.key});

  @override
  State<PeettyDemo> createState() => _PeettyDemoState();
}

class _PeettyDemoState extends State<PeettyDemo> {
  final _companion = GlobalKey<PeettyState>();
  String _figure = presetFigures.first;
  PeettyActivity _activity = PeettyActivity.normal;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Peetty',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xff7a6ee0), useMaterial3: true),
        // Above the navigator, so she stays on screen across routes and dialogs.
        builder: (context, child) => Peetty(key: _companion, figure: _figure, activity: _activity, child: child!),
        home: _Home(
          figure: _figure,
          activity: _activity,
          onFigure: (id) => setState(() => _figure = id),
          onActivity: (activity) => setState(() => _activity = activity),
          onPlay: (state) => _companion.currentState?.play(state),
        ),
      );
}

class _Home extends StatelessWidget {
  const _Home({required this.figure, required this.activity, required this.onFigure, required this.onActivity, required this.onPlay});

  final String figure;
  final PeettyActivity activity;
  final ValueChanged<String> onFigure;
  final ValueChanged<PeettyActivity> onActivity;
  final ValueChanged<FigureState> onPlay;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Peetty for Flutter'),
        actions: [
          DropdownButton<String>(
            value: figure,
            underline: const SizedBox(),
            items: [for (final id in presetFigures) DropdownMenuItem(value: id, child: Text(id))],
            onChanged: (id) => id == null ? null : onFigure(id),
          ),
          const SizedBox(width: 12),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 120, 20, 200),
        children: [
          Text('She stands on the top edges of marked widgets, walks, jumps between them and follows them as you scroll. '
              'Drag her to pick her up, and let go to throw her.', style: theme.textTheme.bodyLarge),
          const SizedBox(height: 24),
          SegmentedButton<PeettyActivity>(
            segments: [for (final a in PeettyActivity.values) ButtonSegment(value: a, label: Text(a.name))],
            selected: {activity},
            onSelectionChanged: (s) => onActivity(s.first),
          ),
          const SizedBox(height: 100),
          Wrap(
            spacing: 12,
            runSpacing: 100,
            children: [
              for (final state in [FigureState.wave, FigureState.sit, FigureState.lie, FigureState.sleep, FigureState.think, FigureState.walk, FigureState.jump])
                PeettyPerch(child: FilledButton.tonal(onPressed: () => onPlay(state), child: Text(state.name))),
            ],
          ),
          for (var i = 0; i < 8; i++) ...[
            const SizedBox(height: 140),
            Align(
              alignment: i.isEven ? Alignment.centerLeft : Alignment.centerRight,
              child: FractionallySizedBox(
                widthFactor: 0.6,
                child: PeettyPerch(
                  preferred: i < 2,
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Text('Card ${i + 1}', style: theme.textTheme.titleMedium),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
