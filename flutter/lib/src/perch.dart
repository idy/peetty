import 'dart:math' as math;

import 'package:flutter/rendering.dart' show RenderOffstage;
import 'package:flutter/widgets.dart';

import 'physics.dart';

/// Marks a widget whose top edge the companion may stand on.
///
/// Place it around cards, buttons, images or any box inside a [Peetty]. Only
/// the visible part of the top edge counts: scrolled-out, clipped or offstage
/// perches are ignored, and she falls when hers goes away.
class PeettyPerch extends StatefulWidget {
  const PeettyPerch({super.key, required this.child, this.preferred = false, this.enabled = true});

  final Widget child;

  /// Preferred perches are chosen about three times as often.
  final bool preferred;

  /// Turns the perch off without changing the tree.
  final bool enabled;

  @override
  State<PeettyPerch> createState() => _PeettyPerchState();
}

class _PeettyPerchState extends State<PeettyPerch> implements PerchSource {
  PerchRegistry? _registry;
  bool _ticking = true;

  @override
  bool get preferred => widget.preferred;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final registry = PerchRegistry.maybeOf(context);
    if (registry != _registry) {
      _registry?.remove(this);
      _registry = registry?..add(this);
    }
  }

  @override
  void dispose() {
    _registry?.remove(this);
    super.dispose();
  }

  @override
  RenderBox? get box {
    // Routes covered by an opaque route, and other offstage subtrees, mute tickers.
    if (!mounted || !widget.enabled || !_ticking) return null;
    final object = context.findRenderObject();
    return object is RenderBox && object.attached && object.hasSize ? object : null;
  }

  @override
  Widget build(BuildContext context) {
    _ticking = TickerMode.valuesOf(context).enabled;
    return widget.child;
  }
}

/// Something that offers a top edge to stand on.
abstract interface class PerchSource {
  RenderBox? get box;
  bool get preferred;
}

/// A top edge in host coordinates. [source] is null for the floor.
class Perch implements Edge {
  const Perch({required this.left, required this.right, required this.y, this.origin = 0, this.source, this.preferred = false});

  @override
  final double left;
  @override
  final double right;
  @override
  final double y;
  final PerchSource? source;
  final bool preferred;

  /// The surface's unclipped left edge, for following it as it moves sideways.
  final double origin;

  bool get isFloor => source == null;

  /// Whether both describe the same surface, wherever it is now.
  bool sameSurface(Perch other) => source == other.source;
}

/// Where her feet may go: x in [left, right], y in [top, bottom].
class Limits {
  const Limits(this.left, this.right, this.top, this.bottom);
  final double left, right, top, bottom;
}

/// Tracks the perches inside one host and measures them.
class PerchRegistry {
  final _sources = <PerchSource>{};

  void add(PerchSource source) => _sources.add(source);
  void remove(PerchSource source) => _sources.remove(source);

  static PerchRegistry? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PerchScope>()?.registry;

  /// Every usable perch, plus the floor.
  List<Perch> scan(RenderBox host, Limits limits) => [
        for (final source in _sources) ?measure(source, host, limits),
        floor(limits),
      ];

  Perch floor(Limits limits) => Perch(left: limits.left, right: limits.right, y: limits.bottom);

  /// The perch as it is now, or null when it can no longer hold her.
  Perch? refresh(Perch perch, RenderBox host, Limits limits) =>
      perch.source == null ? floor(limits) : measure(perch.source!, host, limits);

  /// The visible top edge of [source] in [host] coordinates.
  Perch? measure(PerchSource source, RenderBox host, Limits limits) {
    final box = source.box;
    if (box == null || !host.attached) return null;
    final visible = visibleRect(box, host);
    if (visible == null || visible.isEmpty) return null;
    final bounds = MatrixUtils.transformRect(box.getTransformTo(host), Offset.zero & box.size);
    final top = bounds.top;
    // Her feet need the top edge itself on screen, and her body room above it.
    if (top < visible.top - 0.5 || top > visible.bottom || top < limits.top || top > limits.bottom) return null;
    final inset = math.min(12.0, visible.width * 0.15);
    final left = math.max(visible.left + inset, limits.left);
    final right = math.min(visible.right - inset, limits.right);
    if (right < left) return null;
    return Perch(left: left, right: right, y: top, origin: bounds.left, source: source, preferred: source.preferred);
  }
}

/// The part of [box] not clipped away by its ancestors up to [host], in host coordinates.
Rect? visibleRect(RenderBox box, RenderBox host) {
  RenderObject child = box;
  var rect = MatrixUtils.transformRect(box.getTransformTo(host), Offset.zero & box.size);
  while (child != host) {
    final parent = child.parent;
    if (parent == null) return null; // Not inside the host.
    // Offstage children stay laid out but are never painted.
    if (parent is RenderOffstage && parent.offstage) return null;
    final clip = parent.describeApproximatePaintClip(child);
    if (clip != null) rect = rect.intersect(MatrixUtils.transformRect(parent.getTransformTo(host), clip));
    if (rect.isEmpty) return null;
    child = parent;
  }
  return rect.intersect(Offset.zero & host.size);
}

class PerchScope extends InheritedWidget {
  const PerchScope({super.key, required this.registry, required super.child});
  final PerchRegistry registry;

  @override
  bool updateShouldNotify(PerchScope oldWidget) => registry != oldWidget.registry;
}
