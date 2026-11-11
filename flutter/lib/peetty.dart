/// A little companion for Flutter apps.
///
/// Wrap content in [Peetty] and mark surfaces she may stand on with
/// [PeettyPerch]. Figures use the same JSON format as the web SDK.
library;

export 'src/figure.dart' show Bone, Figure, FigureBehavior, FigureFormatException, FigureState, parseColor;
export 'src/figure_view.dart' show FigureCanvas, FigureController, PeettyFigure, loadFigure, presetFigures;
export 'src/motion.dart' show Emote, Mood;
export 'src/peetty.dart' show Peetty, PeettyActivity, PeettyState;
export 'src/perch.dart' show PeettyPerch;
