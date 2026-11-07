// Riley: an outgoing girl from the United States.
// A high, wavy chestnut ponytail with a red scrunchie and green eyes; a navy-and-cream varsity jacket over a white tee, a
// denim skirt and sneakers. Her idle prop is bubble gum.
import { arms, blush, brows, ellipse, eyes, gum, mouths, pair, part, path, shift, starPath, strands, transformer } from './kit.mjs';

const face = 'M58 86C57 110 72 127 90 131.5Q100 134.5 110 131.5C128 127 143 110 142 86C141 58 124 44 100 44C76 44 59 58 58 86Z';

// Side-parted bangs sweeping to her left.
const bangsEdge = strands([
  [146, 96], [140, 100], [134, 72], [126, 88], [119, 70], [110, 90], [104, 72], [95, 94],
  [90, 74], [82, 90], [77, 74], [69, 90], [65, 76], [60, 100], [54, 97],
]);
const bangs = `M54 97C50 56 72 20 100 20C128 20 150 56 146 96${bangsEdge}Z`;

const eye = eyes({ at: [78.6, 104], scale: 1.1, tilt: -4, height: 1.04, style: 'bright' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };
const patch = transformer({ at: [83, 160], scale: 1, tilt: -8 });

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'riley',
  name: { en: 'Riley', zh: '莱莉', ja: 'ライリー' },
  description: {
    en: 'Sunny and outgoing. Waves at everyone, jumps the highest, and blows bubble gum when she gets bored.',
    zh: '阳光外向，见谁都挥手，跳得最高，无聊了就吹泡泡糖。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 120,
  anchor: [100, 256],
  behavior: { weights: { walk: 4, jump: 4, wave: 2, idle: 3, sit: 1.5, sleep: 0.4 }, walkSpeed: 1.3, jumpPower: 1.3, idleProp: 'gum' },
  palette: {
    skin: '#fff0e6', skinShade: '#f6d0c1', skinLine: '#dfa18d', blush: '#ff8f96', blushLine: '#f0707a',
    lash: '#3a2218', sclera: '#ffffff', eyeShade: '#e2e6d6',
    irisDark: '#1f5a3c', iris: '#3f9a63', irisLight: '#a6dc8c', irisGlow: '#eaffe0', pupil: '#123323',
    mouth: '#94394a', mouthLine: '#83303f', tongue: '#ff9cab', brow: '#7a432a',
    hair: '#c9804d', hairMid: '#b06636', hairTip: '#94502a', hairShade: '#7f4224', hairDeep: '#68351c', hairLine: '#5e2f18', hairShine: '#ffd9b0',
    ribbon: '#e5424f', ribbonDeep: '#bf2f3d', ribbonLine: '#97212f',
    jacket: '#2c3d6c', jacketShade: '#223058', jacketLine: '#18213f', sleeve: '#f4ead7', sleeveShade: '#dfd2ba', sleeveLine: '#a8987c',
    tee: '#ffffff', teeLine: '#c9c4d6', stripe: '#e5424f', star: '#ffd25a', starLine: '#c9922f',
    denim: '#5d82bd', denimDeep: '#45679e', denimLine: '#2f4b78', stitch: '#f1c46b',
    sock: '#ffffff', sockLine: '#c9c4d6', shoe: '#ffffff', shoeLine: '#7f7d92', sole: '#e8e4ef',
    gum: '#ff9fc8', gumLine: '#e36a9f',
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
    hairGrad: { type: 'linear', from: [0, 14], to: [0, 160], stops: [{ offset: 0, color: 'hair' }, { offset: 0.55, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 134], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#ffe9dc' }] },
    denimGrad: { type: 'linear', from: [0, 188], to: [0, 214], stops: [{ offset: 0, color: 'denim' }, { offset: 1, color: 'denimDeep' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // A high ponytail swinging behind her, then the back hair.
    part('ponytail', 'head', 3, [
      path('M116 30C136 16 164 26 166 54C168 74 154 84 158 102C162 120 174 130 166 148C162 156 152 158 148 150C155 141 149 129 143 115C136 99 149 85 147 65C145 49 134 41 120 41Z', hairPaint),
      path('M140 34C154 42 158 56 154 70C150 84 146 94 150 108C154 122 160 132 158 142', { stroke: 'hairShade', strokeWidth: 1.3, opacity: 0.7 }),
      path('M150 32C160 40 162 52 160 62', { stroke: 'hairShine', strokeWidth: 2.2, opacity: 0.5 }),
    ], { pivot: [120, 34], spring: { stiffness: 0.07, damping: 0.87, gain: 1.6, limit: 18, hang: 0.8 } }),
    part('hairBack', 'head', 4, [
      path('M50 92C44 44 76 14 102 15C132 16 158 44 150 94C150 108 147 118 143 126C139 122 135 121 131 121L69 121C65 121 61 122 57 126C53 118 50 108 50 92Z', hairPaint),
    ]),

    // Body.
    ...pair('leg', 'hips', 10, [
      path('M88 208L87 238C87 241 97 241 97 238L98 208Z', { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      path('M87.2 232.5L97.4 232.5L97.2 239L87.1 239Z', { fill: 'sock', stroke: 'sockLine', strokeWidth: 0.6 }),
      path('M87.2 234.4L97.4 234.4', { stroke: 'stripe', strokeWidth: 0.9 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('shoe', 'hips', 12, [
      path('M86 237.6C86 235 98.4 235 98.4 237.6L99 247.6C99.6 251.6 98.4 254.6 95.4 254.6L80.4 254.6C76.4 254.6 75.8 250.6 79.4 248.8L86 246.6Z', { fill: 'shoe', stroke: 'shoeLine', strokeWidth: 1 }),
      path('M76.6 252.4C80 255.8 96 256 99.2 252.2', { stroke: 'sole', strokeWidth: 2.4 }),
      path('M84 246.6C88 244 92 243.6 96.6 244.8', { stroke: 'stripe', strokeWidth: 1.6 }),
      path('M88.4 239.6L94.6 239.6M88.8 242L94.4 242', { stroke: 'shoeLine', strokeWidth: 0.7, opacity: 0.7 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M75 188L125 188L135 213C124 217.4 76 217.4 65 213Z', { fill: 'denimGrad', stroke: 'denimLine', strokeWidth: 1.1 }),
      path('M75.6 193L124.4 193', { stroke: 'denimLine', strokeWidth: 0.8, opacity: 0.7 }),
      path('M100 193L100 216', { stroke: 'stitch', strokeWidth: 0.7, opacity: 0.8 }),
      path('M84 197C86 201 90 202 93 201M116 197C114 201 110 202 107 201', { stroke: 'stitch', strokeWidth: 0.7, opacity: 0.8 }),
      path('M67 210.4C80 214 120 214 133 210.4', { stroke: 'stitch', strokeWidth: 0.7, opacity: 0.8 }),
    ]),
    part('torso', 'body', 20, [
      path('M72 148C74 139 86 137 100 137C114 137 126 139 128 148L132 185C133 191 129 194 123 194L77 194C71 194 67 191 68 185Z', { fill: 'jacket', stroke: 'jacketLine', strokeWidth: 1.1 }),
      path('M92 140L100 149L108 140L106.6 186L93.4 186Z', { fill: 'tee', stroke: 'teeLine', strokeWidth: 0.8 }),
      path('M72 148C70.4 160 69 172 68.2 185C68.4 189.6 70.6 192.4 74.4 193.4C73.2 180 74 162 76.6 150Z', { fill: 'jacketShade' }),
      // Ribbed hem in cream with red stripes, and snap buttons.
      path('M68.6 184.6L131.4 184.6L132 189C132 192 129.6 194 125 194L75 194C70.4 194 68 192 68 189Z', { fill: 'sleeve', stroke: 'sleeveLine', strokeWidth: 0.9 }),
      path('M68.6 187.6L131.4 187.6M68.4 190.4L131.6 190.4', { stroke: 'stripe', strokeWidth: 0.9 }),
      path('M93.2 141L92 184.6M106.8 141L108 184.6', { stroke: 'sleeve', strokeWidth: 1.5 }),
      ellipse(90.2, 158, 1.2, 1.2, { fill: 'sleeve' }), ellipse(90, 172, 1.2, 1.2, { fill: 'sleeve' }),
      ...patch.shapes([
        ellipse(0, 0, 7.4, 7.4, { fill: 'sleeve', stroke: 'stripe', strokeWidth: 1.2 }),
        path(starPath(4.6, 0.48), { fill: 'star', stroke: 'starLine', strokeWidth: 0.6, lineJoin: 'round' }),
      ]),
    ]),
    part('neck', 'body', 21, [
      path('M93 126L93 142C96 144.5 104 144.5 107 142L107 126Z', { fill: 'skin' }),
      path('M93 129C96 135.5 104 135.5 107 129L107 138C104 141 96 141 93 138Z', { fill: 'skinShade' }),
    ]),
    part('collar', 'body', 22, [
      path('M84 139C88 143 92 145 92.4 140.6L94.6 136.6C90.6 135.6 86.6 136 84 139Z', { fill: 'sleeve', stroke: 'sleeveLine', strokeWidth: 0.8 }),
      path('M116 139C112 143 108 145 107.6 140.6L105.4 136.6C109.4 135.6 113.4 136 116 139Z', { fill: 'sleeve', stroke: 'sleeveLine', strokeWidth: 0.8 }),
      path('M85.6 139.2C88.6 141.4 91 142 92.2 140M114.4 139.2C111.4 141.4 109 142 107.8 140', { stroke: 'stripe', strokeWidth: 0.8 }),
    ]),
    ...arms({ shoulder: [77, 146], radius: [10, 9.2, 10.4], sleeve: 'sleeve', shade: 'sleeveShade', line: 'sleeveLine', cuff: 'stripe', cuffWidth: 1.2, cuffBands: 2 }),

    // Face.
    ...pair('ear', 'head', 18, [
      ellipse(58.6, 100, 4.6, 7, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      ellipse(59.4, 100.6, 2, 3.6, { fill: 'skinShade' }),
      ellipse(58.4, 109.6, 1.6, 1.6, { fill: 'star', stroke: 'starLine', strokeWidth: 0.5 }),
    ]),
    part('face', 'head', 20, [
      path(face, { fill: 'skinGrad', stroke: 'skinLine', strokeWidth: 1 }),
      path('M99.4 117.6L100.6 118.8', { stroke: 'skinLine', strokeWidth: 1.1, opacity: 0.6 }),
    ]),
    ...blush({ at: [71, 118] }),
    ...eye.parts,
    ...mouths({ at: [100, 125.6] }),
    ...gum({ at: [100, 125.8] }),
    part('bangShadow', 'head', 47, [path(shift(bangs, 0, 4), { fill: 'skinShade', opacity: 0.5, blend: 'multiply' })], { clip: 'face' }),

    // Front hair: wavy side locks and the bangs.
    ...pair('lock', 'head', 48, [
      path('M62 62C51 82 50 100 54 114C57 124 52 132 56 140C58 144 63 144 63 139C61 132 65 124 63 112C61 98 64 86 72 78Z', hairPaint),
      path('M60 86C57 98 57 108 59 116', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
    ], { pivot: [64, 66], spring: { stiffness: 0.13, damping: 0.84, gain: 0.9, limit: 10, hang: 0.5 } }),
    part('bangs', 'head', 50, [
      path(bangs, { fill: 'hairGrad' }),
      path(`M146 96${bangsEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M119 70C116 80 113 86 110 90M90 74C88 82 85 87 82 90', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.6 }),
    ]),
    part('shine', 'head', 51, [
      path('M64 63C68 52 76 45 86.4 41.6C82 46 76.4 52.4 70.2 63.6Z', { fill: 'hairShine', opacity: 0.6 }),
      path('M90.4 40.4C96.6 38.8 103.4 38.8 109.6 40.4C103.4 43.2 96.6 43.2 90.4 40.4Z', { fill: 'hairShine', opacity: 0.6 }),
      path('M136 63C132 52 124 45 113.6 41.6C118 46 123.6 52.4 129.8 63.6Z', { fill: 'hairShine', opacity: 0.6 }),
    ]),
    part('scrunchie', 'head', 52, [
      path('M112 28C112 21 122 18 127 22C132 20 138 26 135 32C138 38 130 43 125 40C119 44 111 38 114 33C110 32 110 29 112 28Z', { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.9 }),
      path('M117 27C120 29 124 29 127 26M119 35C122 33 127 33 130 35', { stroke: 'ribbonDeep', strokeWidth: 0.8 }),
    ]),
    ...brows({ at: [78, 81.5], tilt: -3 }),
  ],
};
