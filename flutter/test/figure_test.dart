import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:peetty/peetty.dart';
import 'package:peetty/src/motion.dart';
import 'package:peetty/src/rig.dart';

Figure _read(String id) => Figure.fromJson(jsonDecode(File('assets/figures/$id.json').readAsStringSync()));

double Function() _seeded() {
  var state = 7;
  return () {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

void main() {
  test('every catalog figure in the assets is listed and parses', () {
    final index = jsonDecode(File('assets/figures/index.json').readAsStringSync()) as Map<String, Object?>;
    final ids = [for (final entry in index['figures']! as List) (entry as Map)['id'] as String];
    expect(ids, unorderedEquals(presetFigures));
    for (final id in ids) {
      final figure = _read(id);
      expect(figure.id, id);
      expect(figure.parts, isNotEmpty);
      for (final color in figure.palette.values) {
        expect(parseColor(color), isNotNull, reason: '$id: $color');
      }
      // Parts are in draw order.
      for (var i = 1; i < figure.parts.length; i++) {
        expect(figure.parts[i].z, greaterThanOrEqualTo(figure.parts[i - 1].z));
      }
    }
  });

  test('localized names fall back to English', () {
    final miru = _read('miru');
    expect(miru.name('zh'), '米露');
    expect(miru.name('fr'), 'Miru');
  });

  test('rejects data that is not a rig figure', () {
    expect(() => Figure.fromJson({'format': 'nope'}), throwsA(isA<FigureFormatException>()));
    final sprite = jsonDecode(File('assets/figures/miru.json').readAsStringSync()) as Map<String, Object?>;
    sprite['renderer'] = 'sprite';
    expect(() => Figure.fromJson(sprite), throwsA(isA<FigureFormatException>()));
  });

  test('parses the color literals figures use', () {
    expect(parseColor('#fff'), const Color(0xffffffff));
    expect(parseColor('#11223380'), const Color(0x80112233));
    expect(parseColor('rgb(255, 0, 0)')!.toARGB32(), 0xffff0000);
    expect(parseColor('rgba(0 0 255 / 50%)')!.a, closeTo(0.5, 1e-9));
    expect(parseColor('hsl(120, 100%, 50%)')!.toARGB32(), 0xff00ff00);
    expect(parseColor('blue'), isNull);
  });

  group('motion', () {
    test('every state animates every bundled figure without NaN', () {
      for (final id in presetFigures) {
        final figure = _read(id);
        final motion = Motion(behavior: figure.behavior, random: _seeded(), geometry: Geometry.of(figure));
        final rig = Rig(figure);
        for (final state in FigureState.values) {
          motion.play(state);
          for (var i = 0; i < 40; i++) {
            final frame = motion.update(1 / 30);
            rig
              ..setSlots(frame.slots)
              ..setSoul(frame.soul)
              ..frame(frame.pose, 1 / 30, frame.push);
            for (final pose in frame.pose.values) {
              for (final v in [pose.rotate, pose.x, pose.y, pose.sx, pose.sy]) {
                expect(v == null || v.isFinite, isTrue, reason: '$id $state');
              }
            }
          }
        }
      }
    });

    test('a jump crouches before it stretches', () {
      final motion = Motion(random: _seeded());
      motion.play(FigureState.jump);
      final crouch = motion.update(0.14).pose[Bone.root]!.sy!;
      final stretch = motion.update(0.16).pose[Bone.root]!.sy!;
      expect(crouch, lessThan(1));
      expect(stretch, greaterThan(1));
    });

    test('a landing squashes by impact and springs back', () {
      final soft = Motion(random: _seeded())..land(0);
      final hard = Motion(random: _seeded())..land(1);
      final softSquash = soft.update(0.01).pose[Bone.root]!.sy!;
      final hardSquash = hard.update(0.01).pose[Bone.root]!.sy!;
      expect(hardSquash, lessThan(softSquash));
      expect(softSquash, lessThan(1));
      for (var i = 0; i < 60; i++) {
        hard.update(1 / 30);
      }
      expect(hard.update(1 / 30).pose[Bone.root], isNull);
    });

    test('a long fall knocks her soul out, and it returns after landing', () {
      final motion = Motion(random: _seeded())..play(FigureState.fall);
      MotionFrame frame = motion.update(0.05);
      expect(frame.soul, isNull);
      for (var i = 0; i < 20; i++) {
        frame = motion.update(0.05);
      }
      expect(frame.soul, isNotNull);
      motion.land(0.5);
      for (var i = 0; i < 30; i++) {
        frame = motion.update(0.05);
      }
      expect(frame.soul, isNull);
    });
  });
}
