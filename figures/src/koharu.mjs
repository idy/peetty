// Koharu (小春, the mild days of early winter): a sleepy, warm napper.
// Peach-coral bob with curled tips, a cream beret with cat-ear points and a
// star hairpin, honey eyes; sailor-collar dress, neckerchief, knee socks.
import { arms, around, blush, brows, ellipse, eyes, mouths, pair, part, path, shift, starPath, strands, transformer } from './kit.mjs';

const face = 'M58 88C57 111 72 128 90 132Q100 135 110 132C128 128 143 111 142 88C141 60 124 46 100 46C76 46 59 60 58 88Z';

// Rounder, shorter bangs: soft tips just above the eyes.
const bangsEdge = strands([
  [147, 100], [141, 98], [137, 78], [130, 90], [124, 76], [116, 89], [110, 76], [102, 92],
  [97, 77], [89, 90], [83, 77], [75, 89], [69, 78], [60, 98], [53, 100],
]);
const bangs = `M53 100C49 60 70 30 100 30C130 30 151 60 147 100${bangsEdge}Z`;

const eye = eyes({ at: [79, 105], scale: 1.12, tilt: 4, height: 0.98, style: 'sleepy' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };
const star = transformer({ at: [140, 68], scale: 1, tilt: 12 });

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'koharu',
  name: { en: 'Koharu', zh: '小春', ja: 'こはる' },
  description: {
    en: 'Warm and drowsy. Naps on sunny cards and stretches when she wakes.',
    zh: '暖洋洋、懒洋洋，在晒得到太阳的卡片上打盹，醒来伸个懒腰。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 116,
  anchor: [100, 256],
  behavior: { weights: { sleep: 4, sit: 3, idle: 2, walk: 1, jump: 1 }, walkSpeed: 0.7, jumpPower: 0.9, idleProp: 'stretch' },
  sounds: {
    volume: 0.28, cooldown: 1.2,
    events: {
      wave: [{ notes: [392, 494, 440], duration: 0.12 }],
      jump: [{ notes: [262, 392], duration: 0.09 }],
      land: [{ notes: [147, 131], duration: 0.065, volume: 0.55 }],
      drag: [{ notes: [440, 349, 294], duration: 0.09 }],
      sleep: [{ notes: [330, 294, 220], duration: 0.2, volume: 0.6 }],
      wake: [{ notes: [220, 294, 392], duration: 0.14 }],
      talk: [{ notes: [392, 440], duration: 0.065, volume: 0.4 }],
    },
  },
  palette: {
    skin: '#fff3ea', skinShade: '#f6d0c2', skinLine: '#e0a291', blush: '#ff8f8f', blushLine: '#f07272',
    lash: '#5a3328', sclera: '#ffffff', eyeShade: '#f6dccb',
    irisDark: '#93430f', iris: '#e0892b', irisLight: '#ffd77a', irisGlow: '#fff5d2', pupil: '#652b07',
    mouth: '#a2434e', mouthLine: '#93393f', tongue: '#ff9f9f', brow: '#c96d5f',
    hair: '#ffbfa3', hairMid: '#ffa98d', hairTip: '#f8917f', hairShade: '#ec8a78', hairDeep: '#d96f62', hairLine: '#c35a54', hairShine: '#fff4ea',
    beret: '#fff6e8', beretShade: '#f0dcc0', beretLine: '#c6a27f', earInner: '#ffc2b6',
    star: '#ffd25a', starLine: '#d9963a',
    dress: '#fff8ee', dressShade: '#f1dfc8', dressLine: '#c9aa8a',
    collar: '#ec8573', collarLine: '#bf5d50', stripe: '#ffffff',
    ribbon: '#ffc85a', ribbonDeep: '#efa53a', ribbonLine: '#c4802a',
    sock: '#ffffff', sockBand: '#ec8573', shoe: '#8b5a43', shoeLine: '#5c3826',
  },
  skeleton: {
    root: { pivot: [100, 256] },
    hips: { pivot: [100, 196] },
    legL: { pivot: [93, 214] },
    legR: { pivot: [107, 214] },
    body: { pivot: [100, 192] },
    head: { pivot: [100, 136] },
    armL: { pivot: [77, 148] },
    armR: { pivot: [123, 148] },
  },
  gradients: {
    ...eye.gradients,
    hairGrad: { type: 'linear', from: [0, 30], to: [0, 142], stops: [{ offset: 0, color: 'hair' }, { offset: 0.55, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 136], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#ffece2' }] },
    beretGrad: { type: 'radial', center: [92, 30], radius: 64, focus: [84, 22], stops: [{ offset: 0, color: '#ffffff' }, { offset: 0.6, color: 'beret' }, { offset: 1, color: 'beretShade' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // Bob, behind the face: ends at the chin with inward curls.
    part('hairBack', 'head', 4, [
      path('M47 98C41 52 72 22 100 22C128 22 159 52 153 98C153 116 151 128 147 137C142 143 133 143 129 137L71 137C67 143 58 143 53 137C49 128 47 116 47 98Z', hairPaint),
      path('M66 128C80 134 120 134 134 128L133 136C120 140 80 140 67 136Z', { fill: 'hairDeep', opacity: 0.5 }),
    ]),

    // Body.
    ...pair('leg', 'hips', 10, [
      path('M88.4 214L87.6 240C87.6 242.4 96.8 242.4 96.8 240L97.6 214Z', { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      path('M87.9 224.4L97.3 224.4L96.9 241L87.7 241Z', { fill: 'sock', stroke: 'dressLine', strokeWidth: 0.6 }),
      path('M87.9 226.4L97.3 226.4', { stroke: 'sockBand', strokeWidth: 1.6 }),
      path('M87.9 229.2L97.2 229.2', { stroke: 'sockBand', strokeWidth: 0.9, opacity: 0.8 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('shoe', 'hips', 12, [
      path('M86 238.6C86 235.8 98 235.8 98 238.6L98.6 249C99 253 98 255 95 255L82.4 255C78.4 255 78 251.4 81 249.6L86 248Z', { fill: 'shoe', stroke: 'shoeLine', strokeWidth: 1 }),
      path('M85.8 242.4C89 243.6 94 243.6 97.8 242.2', { stroke: 'shoeLine', strokeWidth: 1 }),
      path('M79.4 253.2C82 255 92 255.4 97.8 254', { stroke: '#ffffff', strokeWidth: 0.8, opacity: 0.3 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M72 186L128 186L141 216C129 222 71 222 59 216Z', { fill: 'dress', stroke: 'dressLine', strokeWidth: 1.1 }),
      path('M85 188L77.4 219.4M100 188L100 221M115 188L122.6 219.4', { stroke: 'dressLine', strokeWidth: 0.9, opacity: 0.6 }),
      path('M61.6 212C76 217.2 124 217.2 138.4 212', { stroke: 'collar', strokeWidth: 2 }),
      path('M62.8 208.6C77 213.4 123 213.4 137.2 208.6', { stroke: 'collar', strokeWidth: 0.8, opacity: 0.8 }),
    ]),
    part('torso', 'body', 20, [
      path('M72 150C74 141 86 139 100 139C114 139 126 141 128 150L131 188C131 191 128 192 124 192L76 192C72 192 69 191 69 188Z', { fill: 'dress', stroke: 'dressLine', strokeWidth: 1.1 }),
      path('M72 150C70.6 162 69.6 175 69.2 187C70.6 190 72.6 191 75 191.4C74 178 74.6 164 76.6 152Z', { fill: 'dressShade' }),
      path('M69.4 186.6C80 189 120 189 130.6 186.6', { stroke: 'dressLine', strokeWidth: 0.9, opacity: 0.7 }),
    ]),
    part('neck', 'body', 21, [
      path('M93 128L93 144C96 146.4 104 146.4 107 144L107 128Z', { fill: 'skin' }),
      path('M93 131C96 137.5 104 137.5 107 131L107 140C104 143 96 143 93 140Z', { fill: 'skinShade' }),
    ]),
    part('sailorCollar', 'body', 22, [
      path('M75 148C77 141 87 139.4 92 141L100 160L108 141C113 139.4 123 141 125 148C124 155 118 158 111 156.4L100 167L89 156.4C82 158 76 155 75 148Z', { fill: 'collar', stroke: 'collarLine', strokeWidth: 1 }),
      path('M78.4 148.6C79.6 153 84 154.6 89.4 153.4L99.4 163M121.6 148.6C120.4 153 116 154.6 110.6 153.4L100.6 163', { stroke: 'stripe', strokeWidth: 1.1 }),
    ]),
    part('kerchief', 'body', 23, [
      path('M100 160C96.6 163 94 170 92 177L96 175.6L97.6 179C99 173.6 99.8 167.6 100.4 161Z', { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.8 }),
      path('M100 160C103.4 163 106 170 108 177L104 175.6L102.4 179C101 173.6 100.2 167.6 99.6 161Z', { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.8 }),
      ellipse(100, 160.4, 3.6, 3, { fill: 'ribbonDeep', stroke: 'ribbonLine', strokeWidth: 0.8 }),
    ], { pivot: [100, 160], spring: { stiffness: 0.12, damping: 0.82, gain: 1.4, limit: 14, hang: 0.7 } }),
    ...arms({ shoulder: [77, 148], upper: 21, radius: [11, 8.6, 9.4], z: 21.5, sleeve: 'dress', shade: 'dressShade', line: 'dressLine', cuff: 'collar', cuffWidth: 2 }),

    // Face.
    ...pair('ear', 'head', 18, [
      ellipse(58.6, 102, 4.6, 7, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      ellipse(59.4, 102.6, 2, 3.6, { fill: 'skinShade' }),
    ]),
    part('face', 'head', 20, [
      path(face, { fill: 'skinGrad', stroke: 'skinLine', strokeWidth: 1 }),
    ]),
    ...blush({ at: [71, 119.4], scale: 1.08 }),
    ...eye.parts,
    ...mouths({ at: [100, 126.6], scale: 0.95, cat: true }),
    part('bangShadow', 'head', 47, [path(shift(bangs, 0, 4), { fill: 'skinShade', opacity: 0.5, blend: 'multiply' })], { clip: 'face' }),

    // Front hair: side pieces curl inward at the chin.
    ...pair('side', 'head', 48, [
      path('M60 68C48 90 45 116 51 135C55 143 66 143 69 135.6C63.4 134 61 127.6 62.6 117C64.4 102 66.6 88 72 78Z', hairPaint),
      path('M58 92C54.6 106 54 120 56.4 132', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
      path('M54.6 100C53.4 108 53.4 116 54.6 122', { stroke: 'hairShine', strokeWidth: 1.6, opacity: 0.6 }),
    ], { pivot: [63, 70], spring: { stiffness: 0.14, damping: 0.82, gain: 1, limit: 10, hang: 0.5 } }),
    part('bangs', 'head', 50, [
      path(bangs, { fill: 'hairGrad' }),
      path(`M147 100${bangsEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M97 77C95 82 93 86 89 90M110 76C110 82 108 88 102 92M124 76C124 82 122 86 116 89', { stroke: 'hairShade', strokeWidth: 0.9, opacity: 0.6 }),
    ]),
    part('shine', 'head', 51, [
      path('M60 76C62 68 66 63 72 60C69 64 67 69 65.6 77Z', { fill: 'hairShine', opacity: 0.8 }),
      path('M140 76C138 68 134 63 128 60C131 64 133 69 134.4 77Z', { fill: 'hairShine', opacity: 0.8 }),
    ]),

    // Beret with cat-ear points, tilted to her right.
    part('beret', 'head', 52, around([100, 44], { scale: 0.88, tilt: 7 }, [
      path('M58 40L54 14C53.4 10.6 56.6 9 59 11L76 26Z', { fill: 'beretGrad', stroke: 'beretLine', strokeWidth: 1.1 }),
      path('M59 34L57 18L68 27Z', { fill: 'earInner', opacity: 0.85 }),
      path('M128 24L145 9.6C147.6 7.6 150.6 9.6 149.6 12.6L146 36Z', { fill: 'beretGrad', stroke: 'beretLine', strokeWidth: 1.1 }),
      path('M133 25L145 15L143.6 31Z', { fill: 'earInner', opacity: 0.85 }),
      path('M42 56C40 32 70 14 102 14C134 14 162 26 160 48C159.4 58 150 64 136 61C112 56.6 82 58.4 60 67C49 71 42.6 66 42 56Z', { fill: 'beretGrad', stroke: 'beretLine', strokeWidth: 1.2 }),
      path('M46 60C52 64 58 63.4 62 61.6C84 53 112 51.4 136 55.6C146 57.4 154 54.6 157.6 49', { stroke: 'beretLine', strokeWidth: 1, opacity: 0.55 }),
      path('M62 30C74 22 90 19 104 19.4', { stroke: '#ffffff', strokeWidth: 2.6, opacity: 0.8 }),
      ellipse(104, 14.6, 3.2, 2.4, { fill: 'beretShade', stroke: 'beretLine', strokeWidth: 0.9 }),
    ])),
    part('starPin', 'head', 54, star.shapes([
      path(starPath(6.4, 0.5), { fill: 'star', stroke: 'starLine', strokeWidth: 1, lineJoin: 'round' }),
      ellipse(-1.4, -1.6, 1.4, 1, { fill: '#ffffff', opacity: 0.8 }),
    ])),
    ...brows({ at: [78, 84], tilt: 5 }),
  ],
};
