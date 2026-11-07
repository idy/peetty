// Miru (見る, "to look"): an energetic browser companion.
// Lavender-to-mist-blue twin tails, a cursor hair clip and bows with
// tab-shaped loops; oversized white hoodie, navy pleated skirt, short boots.
import { arms, blush, brows, ellipse, eyes, mouths, pair, part, path, shift, strands, tabBow, transformer } from './kit.mjs';

const face = 'M58 86C57 110 72 127 90 131.5Q100 134.5 110 131.5C128 127 143 110 142 86C141 58 124 44 100 44C76 44 59 58 58 86Z';

const bangsEdge = strands([
  [146, 98], [139, 101], [133, 73], [126, 88], [120, 71], [113, 89], [108, 74], [103, 96],
  [100, 77], [95, 93], [90, 72], [83, 88], [78, 71], [70, 88], [66, 74], [61, 101], [54, 98],
]);
const bangs = `M54 98C50 56 72 20 100 20C128 20 150 56 146 98${bangsEdge}Z`;

const eye = eyes({ at: [78.6, 104], scale: 1.1, tilt: -3, height: 1.04, style: 'bright' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };
const clip = transformer({ at: [124, 40], scale: 1, tilt: 18 });

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'miru',
  name: { en: 'Miru', zh: '米露', ja: 'ミル' },
  description: {
    en: 'Curious and quick. Hops between cards and waves when you look her way.',
    zh: '好奇又轻快，在卡片之间蹦来蹦去，你看她时会挥手。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 120,
  anchor: [100, 256],
  behavior: { weights: { walk: 4, jump: 3, wave: 2, sit: 2, sleep: 1 }, walkSpeed: 1.25, jumpPower: 1.15, idleProp: 'none' },
  palette: {
    skin: '#fff3ec', skinShade: '#f5d2c7', skinLine: '#e0a596', blush: '#ff8fa3', blushLine: '#f06f88',
    lash: '#3b2d58', sclera: '#ffffff', eyeShade: '#d8d2f6',
    irisDark: '#3a3290', iris: '#7a6ee0', irisLight: '#a8d4ff', irisGlow: '#e8f6ff', pupil: '#272062',
    mouth: '#9c3d55', mouthLine: '#8e3048', tongue: '#ff9cab', brow: '#6b5aa8',
    hair: '#cfbaf7', hairMid: '#b0b8f3', hairTip: '#8ebcf2', hairShade: '#9a8be0', hairDeep: '#7466c4', hairLine: '#6a5bb6', hairShine: '#ffffff',
    ribbon: '#ff8db6', ribbonDeep: '#ec6a9b', ribbonLine: '#c4527f',
    hoodie: '#fdfcff', hoodieShade: '#e2e3f5', hoodieLine: '#a7a9d0',
    skirt: '#38438a', skirtDeep: '#262f64', skirtLine: '#1f274f', skirtStripe: '#f4f2ff',
    sock: '#ffffff', boot: '#3b4579', bootLine: '#232a52', bootSole: '#e9e7f8',
    clipFill: '#ffffff', clipLine: '#6a5bb6',
  },
  skeleton: {
    root: { pivot: [100, 256] },
    hips: { pivot: [100, 198] },
    legL: { pivot: [93, 208] },
    legR: { pivot: [107, 208] },
    body: { pivot: [100, 194] },
    head: { pivot: [100, 134] },
    armL: { pivot: [77, 146] },
    armR: { pivot: [123, 146] },
  },
  gradients: {
    ...eye.gradients,
    hairGrad: { type: 'linear', from: [0, 18], to: [0, 204], stops: [{ offset: 0, color: 'hair' }, { offset: 0.42, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 134], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#ffeee6' }] },
    skirtGrad: { type: 'linear', from: [0, 190], to: [0, 218], stops: [{ offset: 0, color: 'skirt' }, { offset: 1, color: 'skirtDeep' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // Behind everything: back hair and twin tails.
    part('hairBack', 'head', 4, [
      path('M50 92C44 44 76 14 102 15C132 16 158 44 150 94C150 110 147 124 142 137C138 131 134 129 130 129L70 129C66 129 62 131 58 137C53 124 50 110 50 92Z', hairPaint),
      path('M66 122C80 130 120 130 134 122L134 129C120 134 80 134 66 129Z', { fill: 'hairDeep', opacity: 0.55 }),
    ]),
    ...pair('tail', 'head', 6, [
      path('M58 51C37 47 20 64 19.5 89C19 113 30 128 28 151C26 171 21 186 29 199C34 206.5 43 207 45 200.5C40 198 37 191 39.5 179C42.6 162 47.4 143 47.4 120C47.4 97 52 77 64 62Z', hairPaint),
      path('M46 74C36 96 38 122 36 148C34 167 32 182 36 194', { stroke: 'hairShade', strokeWidth: 1.4, opacity: 0.7 }),
      path('M30 78C25.6 94 27 108 26.6 124', { stroke: 'hairShine', strokeWidth: 2.4, opacity: 0.55 }),
      path('M31 154C29.6 166 28.4 176 30.4 186', { stroke: 'hairShine', strokeWidth: 1.6, opacity: 0.4 }),
    ], { pivot: [56, 58], spring: { stiffness: 0.07, damping: 0.88, gain: 1.3, limit: 16, hang: 0.75 } }),

    // Body.
    part('hood', 'body', 16, [path('M76 143C78 130 122 130 124 143C116 148 84 148 76 143Z', { fill: 'hoodieShade', stroke: 'hoodieLine', strokeWidth: 1 })]),
    ...pair('leg', 'hips', 10, [
      path('M88 208L87 238C87 241 97 241 97 238L98 208Z', { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      path('M87.2 229.5L97.4 229.5L97.2 238.5L87.1 238.5Z', { fill: 'sock', stroke: 'hoodieLine', strokeWidth: 0.6 }),
      path('M87 231C89 229.6 91 231.6 92.4 230C94 231.6 96 229.6 97.4 231', { stroke: 'hoodieLine', strokeWidth: 0.6, opacity: 0.8 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('boot', 'hips', 12, [
      path('M86 236C86 233.4 98 233.4 98 236L98.6 248C99.2 252 98 255 95 255L81 255C77 255 76.4 251 80 249.2L86 247Z', { fill: 'boot', stroke: 'bootLine', strokeWidth: 1 }),
      path('M77.6 253.4C80 256.4 96 256.6 98.6 253.2', { stroke: 'bootSole', strokeWidth: 2 }),
      path('M88 238.5C89.5 239.5 91.5 239.5 93 238.5', { stroke: 'bootSole', strokeWidth: 0.9, opacity: 0.7 }),
      ellipse(91.8, 241.4, 1.6, 1.4, { fill: 'ribbon' }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M74 189L126 189L139 214C128 219.5 72 219.5 61 214Z', { fill: 'skirtGrad', stroke: 'skirtLine', strokeWidth: 1.1 }),
      path('M86 191L79.5 216.8M100 191L100 218.4M114 191L120.5 216.8', { stroke: 'skirtLine', strokeWidth: 1, opacity: 0.7 }),
      path('M64.5 210.5C76 214.6 124 214.6 135.5 210.5', { stroke: 'skirtStripe', strokeWidth: 1.4, opacity: 0.9 }),
    ]),
    part('torso', 'body', 20, [
      path('M72 148C74 139 86 137 100 137C114 137 126 139 128 148L133 186C134 193 129 197 122 197L78 197C71 197 66 193 67 186Z', { fill: 'hoodie', stroke: 'hoodieLine', strokeWidth: 1.1 }),
      path('M72 148C70 160 68.5 174 67.5 186C67.4 191 70 194.6 74 196C72.4 184 73.4 164 76.4 150Z', { fill: 'hoodieShade' }),
      path('M128 148C130 160 131.5 174 132.5 186C132.6 191 130 194.6 126 196C127.6 184 126.6 164 123.6 150Z', { fill: 'hoodieShade', opacity: 0.7 }),
      path('M67.4 188.6C80 191.4 120 191.4 132.6 188.6', { stroke: 'hoodieLine', strokeWidth: 0.9, opacity: 0.7 }),
      path('M82 174L118 174C120 180 121 185 121 189.5L79 189.5C79 185 80 180 82 174Z', { stroke: 'hoodieLine', strokeWidth: 0.9, opacity: 0.6 }),
      path('M86 140C92 147 108 147 114 140C112 145.5 106 150 100 150C94 150 88 145.5 86 140Z', { fill: 'hoodieShade', stroke: 'hoodieLine', strokeWidth: 0.8 }),
      path('M94.4 148L92.4 165M105.6 148L107.6 165', { stroke: 'ribbon', strokeWidth: 1.4 }),
      ellipse(92.3, 166.6, 1.5, 1.9, { fill: 'ribbonDeep' }),
      ellipse(107.7, 166.6, 1.5, 1.9, { fill: 'ribbonDeep' }),
    ]),
    part('neck', 'body', 21, [
      path('M93 126L93 142C96 144.5 104 144.5 107 142L107 126Z', { fill: 'skin' }),
      path('M93 129C96 135.5 104 135.5 107 129L107 138C104 141 96 141 93 138Z', { fill: 'skinShade' }),
    ]),
    ...arms({ shoulder: [77, 146], radius: [10, 9, 10.6], sleeve: 'hoodie', shade: 'hoodieShade', line: 'hoodieLine', cuff: 'hoodieLine', cuffBands: 2 }),

    // Face.
    ...pair('ear', 'head', 18, [
      ellipse(58.6, 100, 4.6, 7, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      ellipse(59.4, 100.6, 2, 3.6, { fill: 'skinShade' }),
    ]),
    part('face', 'head', 20, [
      path(face, { fill: 'skinGrad', stroke: 'skinLine', strokeWidth: 1 }),
      path('M99.4 117.6L100.6 118.8', { stroke: 'skinLine', strokeWidth: 1.1, opacity: 0.6 }),
    ]),
    ...blush({ at: [71, 118] }),
    ...eye.parts,
    ...mouths({ at: [100, 125.6] }),
    part('bangShadow', 'head', 47, [path(shift(bangs, 0, 4), { fill: 'skinShade', opacity: 0.55, blend: 'multiply' })], { clip: 'face' }),

    // Front hair.
    ...pair('lock', 'head', 48, [
      path('M62 62C51 84 49 112 53 138C54 143 59 144 60 139C60 120 64 100 72 80Z', hairPaint),
      path('M60 82C56 100 55 118 56.6 134', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
    ], { pivot: [64, 66], spring: { stiffness: 0.14, damping: 0.84, gain: 0.8, limit: 9, hang: 0.5 } }),
    part('bangs', 'head', 50, [
      path(bangs, { fill: 'hairGrad' }),
      path(`M146 98${bangsEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M90 72C88 80 86 84 84 87M108 74C109 82 110 86 112 88M120 71C122 78 124 83 126 87', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.6 }),
    ]),
    part('shine', 'head', 51, [
      path('M64 63C68 52 76 45 86.4 41.6C82 46 76.4 52.4 70.2 63.6Z', { fill: 'hairShine', opacity: 0.7 }),
      path('M90.4 40.4C96.6 38.8 103.4 38.8 109.6 40.4C103.4 43.2 96.6 43.2 90.4 40.4Z', { fill: 'hairShine', opacity: 0.7 }),
      path('M136 63C132 52 124 45 113.6 41.6C118 46 123.6 52.4 129.8 63.6Z', { fill: 'hairShine', opacity: 0.7 }),
    ]),
    part('ahoge', 'head', 49, [
      path('M98.6 23C94 11 99.6 2 112.6 3C106 6 102.6 12 104.4 23Z', hairPaint),
    ], { pivot: [101.4, 22], spring: { stiffness: 0.12, damping: 0.8, gain: 2.2, limit: 26, hang: 0.9 } }),
    ...pair('bow', 'head', 53, tabBow({ at: [57, 56], scale: 1, tilt: -18 })),
    part('cursorClip', 'head', 54, clip.shapes([
      path('M0 0L0 13.4L3.3 10.2L5.7 15.6L8 14.6L5.6 9.3L9.9 9.1Z', { fill: 'clipFill', stroke: 'clipLine', strokeWidth: 1.2, lineJoin: 'round' }),
    ])),
    ...brows({ at: [78, 81.5], tilt: -4 }),
  ],
};
