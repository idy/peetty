import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'figure.dart';
import 'motion.dart';
import 'rig.dart';

const _emotes = {
  Emote.note: '♪',
  Emote.sweat: '💧',
  Emote.alert: '!',
  Emote.sleep: 'z',
  Emote.heart: '♡',
  Emote.dizzy: '✦',
  Emote.flash: '✧',
};

/// The figures bundled with the package, in catalog order.
const presetFigures = ['miru', 'koharu', 'xiaoxiao', 'riley', 'amara', 'elsie', 'shiori'];

/// Loads a bundled figure such as `miru` from the package assets.
Future<Figure> loadFigure(String id, {AssetBundle? bundle}) async {
  if (!presetFigures.contains(id)) throw ArgumentError.value(id, 'id', 'not a bundled figure');
  final text = await (bundle ?? rootBundle).loadString('packages/peetty/assets/figures/$id.json');
  return Figure.fromJson(jsonDecode(text));
}

/// A live figure: renderer, animator, facing and emote, advanced by [step].
class FigureController extends ChangeNotifier {
  FigureController(this.figure, {double scale = 1, double Function()? random, Map<String, String> palette = const {}})
      : rig = Rig(figure, palette: palette),
        motion = Motion(behavior: figure.behavior, random: random, geometry: Geometry.of(figure)),
        height = figure.height * scale,
        width = figure.height * scale * figure.viewBox.width / figure.viewBox.height {
    unitsPerPixel = figure.viewBox.width / width;
    anchor = Offset((figure.anchor.dx - figure.viewBox.left) / unitsPerPixel, (figure.anchor.dy - figure.viewBox.top) / unitsPerPixel);
    _emoteSize = 18 * scale;
  }

  final Figure figure;
  final Rig rig;
  final Motion motion;

  /// Rendered size in logical pixels.
  final double width;
  final double height;

  /// viewBox units per logical pixel.
  late final double unitsPerPixel;

  /// The anchor (feet) in logical pixels from the top-left corner.
  late final Offset anchor;
  late final double _emoteSize;

  int _facing = 1;
  bool _cut = false;
  Emote? _emote;
  Emote? _shownEmote;
  double _emoteOpacity = 0;
  Offset? _pointer;
  bool _disposed = false;

  int get facing => _facing;

  void play(FigureState state) => motion.play(state);

  void setFacing(int direction) {
    if (direction == 0 || direction.sign == _facing) return;
    _facing = direction.sign;
    notifyListeners();
  }

  /// Where the pointer is relative to the figure's top-left corner; null stops following.
  void setPointer(Offset? local) => _pointer = local;

  /// Advances the animation by [dt] seconds. With [reducedMotion], movement slows down.
  void step(double dt, {bool reducedMotion = false}) {
    if (_disposed) return;
    final frame = motion.update(reducedMotion ? dt * 0.25 : dt);
    if (frame.look case final look?) {
      rig.setLook(look.dx, look.dy);
    } else if (_pointer case final p?) {
      final dx = (p.dx - width / 2) / (width * 2.5) * _facing;
      final dy = (p.dy - height * 0.4) / (height * 2);
      rig.setLook(dx, dy);
      motion.setGaze(dx, dy);
    }
    rig.setSlots(frame.slots);
    rig.setSoul(frame.soul);
    rig.frame(frame.pose, dt, frame.push);
    _cut = frame.cut;
    _emote = frame.emote;
    if (_emote != null) _shownEmote = _emote;
    // A quarter-second fade, like the web emote's opacity transition.
    _emoteOpacity = (_emoteOpacity + (_emote != null ? dt : -dt) * 4).clamp(0.0, 1.0);
    notifyListeners();
  }

  /// Whether a point relative to the top-left corner lands on her drawing.
  bool hitTest(Offset local) {
    if (_cut && local.dy > anchor.dy) return false;
    final x = _facing == -1 ? 2 * anchor.dx - local.dx : local.dx;
    final vb = figure.viewBox;
    return rig.hitTest(Offset(x * unitsPerPixel + vb.left, local.dy * unitsPerPixel + vb.top));
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Paints a [FigureController]; the drawing may overflow its box while moving.
class FigureCanvas extends StatelessWidget {
  const FigureCanvas({super.key, required this.controller, this.semanticLabel});

  final FigureController controller;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) => Semantics(
        image: true,
        label: semanticLabel ?? controller.figure.name(Localizations.maybeLocaleOf(context)?.languageCode ?? 'en'),
        child: SizedBox(
          width: controller.width,
          height: controller.height,
          child: CustomPaint(painter: _FigurePainter(controller)),
        ),
      );
}

class _FigurePainter extends CustomPainter {
  _FigurePainter(this.c) : super(repaint: c);
  final FigureController c;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    if (c._facing == -1) {
      canvas.translate(c.anchor.dx, 0);
      canvas.scale(-1, 1);
      canvas.translate(-c.anchor.dx, 0);
    }
    // Lying on an edge: hide what lies below it, as if she were behind it.
    if (c._cut) canvas.clipRect(Rect.fromLTRB(-1e4, -1e4, 1e4, c.anchor.dy));
    canvas.scale(1 / c.unitsPerPixel);
    canvas.translate(-c.figure.viewBox.left, -c.figure.viewBox.top);
    c.rig.paint(canvas);
    canvas.restore();

    if (c._emoteOpacity > 0 && c._shownEmote != null) {
      final text = TextPainter(
        text: TextSpan(
          text: _emotes[c._shownEmote]!,
          style: TextStyle(
            fontSize: c._emoteSize,
            height: 1,
            fontWeight: FontWeight.w600,
            color: const Color(0xff7a6ee0).withValues(alpha: c._emoteOpacity),
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      text.paint(canvas, Offset(size.width * 0.92 - text.width, -size.height * 0.02));
      text.dispose();
    }
  }

  @override
  bool? hitTest(Offset position) => c.hitTest(position);

  @override
  bool shouldRepaint(_FigurePainter oldDelegate) => oldDelegate.c != c;
}

/// A standalone animated figure playing one state, e.g. for a character picker.
class PeettyFigure extends StatefulWidget {
  const PeettyFigure({super.key, required this.figure, this.state = FigureState.idle, this.scale = 1, this.facing = 1});

  final Figure figure;
  final FigureState state;
  final double scale;

  /// 1 faces right, -1 faces left.
  final int facing;

  @override
  State<PeettyFigure> createState() => _PeettyFigureState();
}

class _PeettyFigureState extends State<PeettyFigure> with SingleTickerProviderStateMixin {
  late FigureController _controller;
  late final Ticker _ticker;
  Duration _last = Duration.zero;
  bool _reducedMotion = false;

  @override
  void initState() {
    super.initState();
    _controller = _create();
    _ticker = createTicker((elapsed) {
      final dt = math.min((elapsed - _last).inMicroseconds / 1e6, 0.1);
      _last = elapsed;
      _controller.step(dt, reducedMotion: _reducedMotion);
    })
      ..start();
  }

  FigureController _create() => FigureController(widget.figure, scale: widget.scale)
    ..play(widget.state)
    ..setFacing(widget.facing);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reducedMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  }

  @override
  void didUpdateWidget(PeettyFigure oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.figure != widget.figure || oldWidget.scale != widget.scale) {
      _controller.dispose();
      _controller = _create();
    }
    _controller
      ..play(widget.state)
      ..setFacing(widget.facing);
  }

  @override
  void dispose() {
    _ticker.dispose();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FigureCanvas(controller: _controller);
}
