// Xiaoxiao (林筱筱): a quick, cheerful girl from China.
// Soft black double buns tied with red cords and little tassels, warm brown
// eyes; a modern rose-red top with a mandarin collar, frog buttons and a cloud
// motif, a navy pleated skirt. Her idle prop is a cup of milk tea.
import { arms, blush, bow, brows, ellipse, eyes, mouths, pair, part, path, strands } from './kit.mjs';

const face = 'M58 86C57 110 72 127 90 131.5Q100 134.5 110 131.5C128 127 143 110 142 86C141 58 124 44 100 44C76 44 59 58 58 86Z';

// Fairly even bangs with soft tips, longer at the sides.
const edge = (dy) => strands([
  [146, 98 + dy], [140, 99 + dy], [136, 82 + dy], [130, 92 + dy], [124, 80 + dy], [117, 92 + dy], [111, 80 + dy], [104, 93 + dy],
  [98, 80 + dy], [92, 92 + dy], [86, 80 + dy], [79, 92 + dy], [73, 80 + dy], [66, 92 + dy], [62, 82 + dy], [59, 99 + dy], [54, 98 + dy],
]);
const bangsEdge = edge(0);

const eye = eyes({ at: [78.6, 104], scale: 1.1, tilt: -4, height: 1.02, style: 'bright' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };

const frog = (x, y) => [
  path(`M${x - 3.4} ${y}L${x + 3.4} ${y}`, { stroke: 'knot', strokeWidth: 1.2 }),
  ellipse(x, y, 1.5, 1.5, { fill: 'knot' }),
];

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'xiaoxiao',
  name: { en: 'Xiaoxiao', zh: '林筱筱', ja: 'シャオシャオ' },
  description: {
    en: 'Bright and quick, with a cup of milk tea never far away. Loves to run and hop around.',
    zh: '机灵爱笑，手边总有一杯奶茶，喜欢跑来跑去、蹦蹦跳跳。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 120,
  anchor: [100, 256],
  behavior: { weights: { walk: 4, jump: 3, idle: 3, sit: 2, sleep: 0.5 }, walkSpeed: 1.2, jumpPower: 1.1, idleProp: 'cup' },
  palette: {
    skin: '#fdecdc', skinShade: '#f0cdb4', skinLine: '#d9a183', blush: '#ff8f9c', blushLine: '#f06f80',
    lash: '#2a1d24', sclera: '#ffffff', eyeShade: '#ead7df',
    irisDark: '#4a2418', iris: '#8f4f2e', irisLight: '#dba066', irisGlow: '#ffeccf', pupil: '#2c120a',
    mouth: '#9c3d50', mouthLine: '#8c3046', tongue: '#ff9cab', brow: '#3e3550',
    hair: '#4f4864', hairMid: '#3b3651', hairTip: '#2e2a41', hairShade: '#242030', hairDeep: '#1d1a27', hairLine: '#1b1824', hairShine: '#aeb8e6',
    ribbon: '#e8424f', ribbonDeep: '#c72f3f', ribbonLine: '#9e2333', gold: '#f2c35a',
    top: '#e7525d', topShade: '#c93f4c', topLine: '#a3313d', piping: '#fff2df', knot: '#fff2df',
    skirt: '#2f3d6e', skirtDeep: '#222c52', skirtLine: '#18203f',
    sock: '#ffffff', sockLine: '#c9c4dc', shoe: '#2b2433', shoeLine: '#17121c',
    cupClear: '#ffffff', cupLine: '#b8a9b8', tea: '#d9a77a', teaDeep: '#b98352', pearl: '#3a2420', cupBand: '#ffb3c4', straw: '#ff7fa8',
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
    hairGrad: { type: 'linear', from: [0, 14], to: [0, 150], stops: [{ offset: 0, color: 'hair' }, { offset: 0.5, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 134], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#fbe5d2' }] },
    skirtGrad: { type: 'linear', from: [0, 190], to: [0, 218], stops: [{ offset: 0, color: 'skirt' }, { offset: 1, color: 'skirtDeep' }] },
    teaGrad: { type: 'linear', from: [0, 172], to: [0, 193], stops: [{ offset: 0, color: 'tea' }, { offset: 1, color: 'teaDeep' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // Back hair to the shoulders, buns and tassels.
    part('hairBack', 'head', 4, [
      path('M50 92C44 44 76 16 100 16C124 16 156 44 150 92C151 116 150 134 146 148C138 145 130 144 124 146L76 146C70 144 62 145 54 148C50 134 49 116 50 92Z', hairPaint),
      path('M60 138C78 143 122 143 140 138L141 145C122 149 78 149 59 145Z', { fill: 'hairDeep', opacity: 0.5 }),
    ]),
    ...pair('bun', 'head', 5, [
      ellipse(60, 31, 16, 15, hairPaint),
      path('M50 30C52 23 62 21 68 26C72 30 70 36 64 36', { stroke: 'hairShade', strokeWidth: 1.1, opacity: 0.8 }),
      path('M51.6 26.4C54.6 21.6 61 20.4 65 22.4', { stroke: 'hairShine', strokeWidth: 1.6, opacity: 0.5 }),
    ]),
    ...pair('tassel', 'head', 6, [
      path('M48.6 47C48.2 54 47.8 60 47.6 64', { stroke: 'ribbon', strokeWidth: 1.3 }),
      ellipse(47.6, 65.6, 2.2, 2, { fill: 'ribbonDeep' }),
      path('M45.4 67.4L44.4 79C46 80.6 49.4 80.6 51 79L49.8 67.4Z', { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.7 }),
      path('M46.6 69.6L46.2 78M48.4 69.6L48.6 78', { stroke: 'ribbonLine', strokeWidth: 0.5, opacity: 0.6 }),
      path('M45 67.6L50.2 67.6', { stroke: 'gold', strokeWidth: 1.4 }),
    ], { pivot: [48.6, 47], spring: { stiffness: 0.09, damping: 0.86, gain: 1.6, limit: 20, hang: 0.85 } }),

    // Body.
    ...pair('leg', 'hips', 10, [
      path('M88 208L87 238C87 241 97 241 97 238L98 208Z', { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      path('M87.2 231.5L97.4 231.5L97.2 238.5L87.1 238.5Z', { fill: 'sock', stroke: 'sockLine', strokeWidth: 0.6 }),
      path('M86.6 232C88.4 230.2 90.4 232.6 92.2 230.8C94 232.6 96 230.2 97.8 232', { stroke: 'sockLine', strokeWidth: 0.7 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('shoe', 'hips', 12, [
      path('M86.4 238.4C86.4 235.6 98 235.6 98 238.4L98.6 249C99 253 98 255 95 255L83 255C79 255 78.6 251.6 81.4 250L86.4 248.6Z', { fill: 'shoe', stroke: 'shoeLine', strokeWidth: 1 }),
      path('M86.8 242.4L97.8 242', { stroke: 'ribbon', strokeWidth: 1.6 }),
      ellipse(95.4, 242.2, 1.1, 1.1, { fill: 'gold' }),
      path('M80 252.6C83 254 92 254.4 97.6 253.4', { stroke: '#ffffff', strokeWidth: 0.8, opacity: 0.25 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M74 189L126 189L139 214C128 219.5 72 219.5 61 214Z', { fill: 'skirtGrad', stroke: 'skirtLine', strokeWidth: 1.1 }),
      path('M86 191L79.5 216.8M100 191L100 218.4M114 191L120.5 216.8', { stroke: 'skirtLine', strokeWidth: 1, opacity: 0.7 }),
      path('M64.5 210.5C76 214.6 124 214.6 135.5 210.5', { stroke: 'piping', strokeWidth: 1.3, opacity: 0.9 }),
    ]),
    part('torso', 'body', 20, [
      path('M73 148C75 139 86 137 100 137C114 137 125 139 127 148L131 184C132 190 128 193 122 193L78 193C72 193 68 190 69 184Z', { fill: 'top', stroke: 'topLine', strokeWidth: 1.1 }),
      path('M73 148C71.4 160 70 172 69.2 184C69.2 188.6 71.4 191.6 75 192.6C73.8 180 74.6 162 77.2 150Z', { fill: 'topShade', opacity: 0.8 }),
      path('M127 148C128.6 160 130 172 130.8 184C130.8 188.6 128.6 191.6 125 192.6C126.2 180 125.4 162 122.8 150Z', { fill: 'topShade', opacity: 0.55 }),
      // Diagonal front closure with frog buttons.
      path('M100 145.6C108 148 116 150 122.4 154', { stroke: 'piping', strokeWidth: 1.4 }),
      path('M119 152.8L119.6 192.4', { stroke: 'piping', strokeWidth: 1.1, opacity: 0.9 }),
      ...frog(105, 147.4), ...frog(113.4, 150.6), ...frog(119.3, 164), ...frog(119.5, 178),
      // A cloud scroll near the hem.
      path('M77.6 181C77.4 177 82.4 175.8 84.2 178.8C85 175 90.6 175.2 90.4 179.4C93 179.4 93.6 183.4 90.6 183.8L79.4 183.8C76.8 183.8 76.2 181.6 77.6 181Z', { stroke: 'piping', strokeWidth: 1, opacity: 0.9 }),
      path('M69.4 188.6C80 191.6 120 191.6 130.6 188.6', { stroke: 'piping', strokeWidth: 1.3 }),
    ]),
    part('neck', 'body', 21, [
      path('M93 126L93 142C96 144.5 104 144.5 107 142L107 126Z', { fill: 'skin' }),
      path('M93 129C96 135.5 104 135.5 107 129L107 138C104 141 96 141 93 138Z', { fill: 'skinShade' }),
    ]),
    part('collar', 'body', 22, [
      path('M89 136.4C92 141 108 141 111 136.4L111.6 143.4C108 146.8 92 146.8 88.4 143.4Z', { fill: 'top', stroke: 'topLine', strokeWidth: 0.9 }),
      path('M88.6 143.2C92 146.6 108 146.6 111.4 143.2', { stroke: 'piping', strokeWidth: 1.1 }),
      path('M89.2 137C92.4 141.4 107.6 141.4 110.8 137', { stroke: 'piping', strokeWidth: 0.9, opacity: 0.8 }),
    ]),
    part('milkTea', 'body', 25, [
      path('M90.5 165L109.5 165L107 191C106.8 192.6 105.6 193.4 104 193.4L96 193.4C94.4 193.4 93.2 192.6 93 191Z', { fill: 'cupClear', opacity: 0.8 }),
      path('M91.2 172L108.8 172L107 191C106.8 192.6 105.6 193.4 104 193.4L96 193.4C94.4 193.4 93.2 192.6 93 191Z', { fill: 'teaGrad' }),
      ellipse(96.4, 189.4, 1.7, 1.6, { fill: 'pearl' }), ellipse(100.2, 190.6, 1.7, 1.6, { fill: 'pearl' }),
      ellipse(104, 189.4, 1.7, 1.6, { fill: 'pearl' }), ellipse(98.2, 186.8, 1.7, 1.6, { fill: 'pearl' }),
      ellipse(102.4, 187.2, 1.7, 1.6, { fill: 'pearl' }),
      path('M91.6 176.6L108.4 176.6L108 182L92 182Z', { fill: 'cupBand' }),
      path('M98.4 178.2C97.2 177 95.6 178.6 97 180C97.6 180.6 98.4 181 98.4 181C98.4 181 99.2 180.6 99.8 180C101.2 178.6 99.6 177 98.4 178.2Z', { fill: '#ffffff' }),
      path('M90.5 165L109.5 165L107 191C106.8 192.6 105.6 193.4 104 193.4L96 193.4C94.4 193.4 93.2 192.6 93 191Z', { stroke: 'cupLine', strokeWidth: 0.9 }),
      path('M92.8 168L94.4 189', { stroke: '#ffffff', strokeWidth: 1.2, opacity: 0.6 }),
      ellipse(100, 165, 10.4, 2.1, { fill: 'cupClear', stroke: 'cupLine', strokeWidth: 0.9 }),
      path('M103 165.6L106.6 147.6', { stroke: 'straw', strokeWidth: 2.8 }),
      ellipse(91.4, 182.4, 3.4, 2.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: -25 }),
      ellipse(108.6, 182.4, 3.4, 2.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: 25 }),
    ], { slot: 'hand:cup' }),
    ...arms({ shoulder: [77, 146], radius: [10, 9.4, 11.4], sleeve: 'top', shade: 'topShade', line: 'topLine', cuff: 'piping', cuffWidth: 1.5 }),

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
    part('bangShadow', 'head', 47, [path(`M54 102C50 60 72 24 100 24C128 24 150 60 146 102${edge(4)}Z`, { fill: 'skinShade', opacity: 0.55, blend: 'multiply' })], { clip: 'face' }),

    // Front hair.
    ...pair('lock', 'head', 48, [
      path('M62 62C52 84 50 108 54 130C55 135 60 136 61 131C61 114 64 98 71 80Z', hairPaint),
      path('M60 84C56.6 100 56 116 57 128', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
    ], { pivot: [64, 66], spring: { stiffness: 0.14, damping: 0.84, gain: 0.8, limit: 9, hang: 0.5 } }),
    part('bangs', 'head', 50, [
      path(`M54 98C50 56 72 20 100 20C128 20 150 56 146 98${bangsEdge}Z`, { fill: 'hairGrad' }),
      path(`M146 98${bangsEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M92 80C91 86 90 89 88 91M111 80C111.6 86 112.6 89 114.4 91', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
    ]),
    part('shine', 'head', 51, [
      path('M64 63C68 52 76 45 86.4 41.6C82 46 76.4 52.4 70.2 63.6Z', { fill: 'hairShine', opacity: 0.55 }),
      path('M90.4 40.4C96.6 38.8 103.4 38.8 109.6 40.4C103.4 43.2 96.6 43.2 90.4 40.4Z', { fill: 'hairShine', opacity: 0.55 }),
      path('M136 63C132 52 124 45 113.6 41.6C118 46 123.6 52.4 129.8 63.6Z', { fill: 'hairShine', opacity: 0.55 }),
    ]),
    ...pair('cord', 'head', 53, bow({ at: [49, 45], scale: 0.78, tilt: -24, tails: 5 })),
    ...brows({ at: [78, 81.5], tilt: -3 }),
  ],
};
