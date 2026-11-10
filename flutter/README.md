# Peetty for Flutter

A Flutter port of the [Peetty](../README.md) companion. She drops in, stands on the top edges of widgets you mark, walks along them, jumps between them, follows them as they scroll, falls when hers goes away, and can be picked up and thrown.

> **Status: prototype.** Movement and animation only. Chat, sounds, the hover menu and speech bubbles from the web SDK are not ported yet.

## Use it

Add the package from this repository:

```yaml
dependencies:
  peetty:
    git:
      url: https://github.com/idy/peetty.git
      path: flutter
```

Wrap your app (or a single screen) and mark surfaces she may stand on:

```dart
import 'package:peetty/peetty.dart';

MaterialApp(
  // Above the navigator, so she stays on screen across routes and dialogs.
  builder: (context, child) => Peetty(figure: 'miru', child: child!),
  home: Scaffold(
    body: ListView(children: [
      PeettyPerch(child: Card(child: Text('She can stand on this card'))),
      PeettyPerch(preferred: true, child: FilledButton(onPressed: () {}, child: Text('And this button'))),
    ]),
  ),
);
```

The bottom of the screen (above the safe-area inset) is always a floor. Only the visible part of a perch's top edge counts: perches scrolled out of view, clipped away or on a route hidden behind another are ignored.

| Widget / API | Purpose |
| --- | --- |
| `Peetty` | Hosts the companion over `child`. Options: `figure` (bundled id), `figureData` (a custom `Figure`), `scale`, `activity` (`calm`, `normal`, `lively`), `visible`. |
| `PeettyPerch` | Marks a widget whose top edge she may stand on. `preferred` perches are chosen about three times as often. |
| `PeettyState.play(FigureState)` | Asks her to wave, sit, lie, sleep, think, walk or jump now. Reach it with a `GlobalKey<PeettyState>` or `Peetty.maybeOf(context)`. |
| `PeettyFigure` | A standalone animated figure playing one state, e.g. for a character picker. |
| `Figure.fromJson` / `loadFigure` | Parse a figure JSON, or load a bundled one. |

Tap her to wave. Drag to pick her up and let go to throw her. With reduced motion (`MediaQuery.disableAnimations`), she slows down and stays put.

## Figures

The package bundles every catalog figure (`miru`, `koharu`, `xiaoxiao`, `riley`, `amara`, `elsie`, `shiori`) from the same JSON format the web SDK uses. `assets/figures/` is a copy of the repository's `figures/` directory: run `npm run figures` at the repository root after changing a figure, and `npm run check` fails when the copy is stale. Rig figures are supported; sprite figures are not yet.

## Development

```bash
cd flutter
flutter pub get
flutter analyze
flutter test
```

The demo app lives in `example/`:

```bash
cd flutter/example
flutter run            # any device, e.g. -d chrome or -d macos
```

| Path | Contents |
| --- | --- |
| `lib/src/figure.dart` | Figure JSON model and parser, color literals |
| `lib/src/motion.dart` | Procedural animation, ported from `src/figure/motion.ts` |
| `lib/src/rig.dart` | Canvas renderer with spring parts, ported from `src/figure/rig.ts` |
| `lib/src/figure_view.dart` | `FigureController`, `FigureCanvas`, `PeettyFigure`, bundled figure loading |
| `lib/src/physics.dart` | Jump planning and landing, ported from `src/pet/physics.ts` |
| `lib/src/perch.dart` | `PeettyPerch` and visible-edge measurement |
| `lib/src/peetty.dart` | The `Peetty` host: drop-in, walking, jumping, falling, hanging, dragging |

Motion and rendering mirror the TypeScript sources; change both together so the companion behaves the same on the web and in Flutter.
