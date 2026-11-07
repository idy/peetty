// Shiori (栞, "bookmark"): a calm reader.
// Long moonlight-silver hair with one side braid tied by a bookmark ribbon,
// a crescent hairpin, rose eyes; cream cardigan over a blouse, long plaid
// skirt, Mary Janes. She often sits on an edge with a tiny book.
import { arms, blush, bow, brows, ellipse, eyes, mouths, pair, part, path, round, shift, strands, transformer } from './kit.mjs';

const face = 'M60 86C59 110 73 127 90 131.5Q100 134.5 110 131.5C127 127 141 110 140 86C139 58 123 44 100 44C77 44 61 58 60 86Z';

// Side-swept bangs: each tip leans left of its parting.
const bangsEdge = strands([
  [146, 100], [142, 104], [138, 74], [128, 93], [124, 70], [113, 91], [110, 68], [98, 95],
  [96, 70], [86, 90], [84, 68], [74, 87], [72, 68], [62, 98], [55, 99],
]);
const bangs = `M55 99C50 56 72 20 100 20C128 20 150 56 146 100${bangsEdge}Z`;

const eye = eyes({ at: [79.4, 104.4], scale: 1.06, tilt: 3, height: 1, style: 'gentle' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };
const moon = transformer({ at: [66, 62], scale: 1, tilt: -30 });

// Braid: alternating lobes, each a teardrop from the center to one side.
const braid = [];
for (let i = 0; i < 14; i++) {
  const y = 101 + i * 6.3;
  const x = 145 - i * 0.12;
  const side = i % 2 ? 1 : -1;
  const w = 7.6 - i * 0.18;
  braid.push(path(`M${round(x)} ${round(y - 5)}C${round(x + side * w * 1.3)} ${round(y - 5)} ${round(x + side * w * 1.2)} ${round(y + 6)} ${round(x + side * 0.6)} ${round(y + 8)}C${round(x - side * 2.4)} ${round(y + 4.4)} ${round(x - side * 1.8)} ${round(y - 1)} ${round(x)} ${round(y - 5)}Z`, { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 0.9 }));
  braid.push(path(`M${round(x + side * 1.6)} ${round(y - 2.6)}C${round(x + side * 4.6)} ${round(y - 2)} ${round(x + side * 5)} ${round(y + 1.6)} ${round(x + side * 3.6)} ${round(y + 4)}`, { stroke: 'hairShine', strokeWidth: 1.1, opacity: 0.75 }));
}

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'shiori',
  name: { en: 'Shiori', zh: '栞', ja: 'しおり' },
  description: {
    en: 'Calm and gentle. Finds a quiet edge, sits down, and reads along with you.',
    zh: '安静温柔，找个安稳的边角坐下，陪你一起读。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 120,
  anchor: [100, 256],
  behavior: { weights: { idle: 4, sit: 4, walk: 1, jump: 0.5, sleep: 1 }, walkSpeed: 0.8, jumpPower: 0.85, idleProp: 'book' },
  palette: {
    skin: '#fff4ee', skinShade: '#f3d3c9', skinLine: '#dba698', blush: '#ff9fae', blushLine: '#ee7d90',
    lash: '#4a3442', sclera: '#ffffff', eyeShade: '#efdbe4',
    irisDark: '#842c4b', iris: '#d3618a', irisLight: '#ffc3d0', irisGlow: '#fff0f4', pupil: '#561a31',
    mouth: '#9a4057', mouthLine: '#8d3a4c', tongue: '#ffa3b0', brow: '#9a8db0',
    hair: '#f6f3fb', hairMid: '#e6e2f1', hairTip: '#d6d1e8', hairShade: '#bcb4d6', hairDeep: '#a59cc4', hairLine: '#8e85af', hairShine: '#ffffff',
    ribbon: '#e5738f', ribbonDeep: '#c95473', ribbonLine: '#a3415c',
    cardi: '#f8eddb', cardiShade: '#ead8bc', cardiLine: '#b8a183', blouse: '#ffffff',
    skirt: '#6f5c80', skirtDeep: '#544466', skirtLine: '#3e3150', plaidA: '#9a86ad', plaidB: '#d9c9e4',
    tights: '#5a4c6a', tightsShade: '#463a54', shoe: '#5a3c4a', shoeLine: '#36242e',
    moon: '#f5cd6e', moonLine: '#c99a3b',
    bookCover: '#b5677e', bookLine: '#7d3d52', page: '#fffaf0', pageLine: '#d9cbb6',
  },
  skeleton: {
    root: { pivot: [100, 256] },
    hips: { pivot: [100, 200] },
    legL: { pivot: [93, 222] },
    legR: { pivot: [107, 222] },
    body: { pivot: [100, 196] },
    head: { pivot: [100, 134] },
    armL: { pivot: [77, 146] },
    armR: { pivot: [123, 146] },
  },
  gradients: {
    ...eye.gradients,
    hairGrad: { type: 'linear', from: [0, 16], to: [0, 210], stops: [{ offset: 0, color: 'hair' }, { offset: 0.5, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 134], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#ffefe7' }] },
    skirtGrad: { type: 'linear', from: [0, 196], to: [0, 234], stops: [{ offset: 0, color: 'skirt' }, { offset: 1, color: 'skirtDeep' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // Long back hair, reaching the hips.
    part('hairBack', 'head', 4, [
      path('M48 94C42 44 74 14 100 14C126 14 158 44 152 94C152 128 156 166 164 202C158 198 154 200 150 208C146 200 142 199 136 204C132 198 128 198 124 202L76 202C72 198 68 198 64 204C58 199 54 200 50 208C46 200 42 198 36 202C44 166 48 128 48 94Z', hairPaint),
      path('M54 120C52 150 48 176 42 198M146 120C148 150 152 176 158 198', { stroke: 'hairShade', strokeWidth: 1.2, opacity: 0.7 }),
      path('M59 132C58 156 57 178 56 200M141 132C142 156 143 178 144 200M50 150C48 168 46 184 44 194M150 150C152 168 154 184 156 194', { stroke: 'hairShade', strokeWidth: 0.9, opacity: 0.5 }),
    ]),

    // Body.
    ...pair('leg', 'hips', 10, [
      path('M88.6 222L88 243C88 245.4 97 245.4 97 243L97.6 222Z', { fill: 'tights', stroke: 'tightsShade', strokeWidth: 0.8 }),
      path('M90 226C90 232 89.8 238 89.6 242', { stroke: '#ffffff', strokeWidth: 0.9, opacity: 0.18 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('shoe', 'hips', 12, [
      path('M86.4 240.4C86.4 237.6 98 237.6 98 240.4L98.6 249C99 253 98 255 95 255L83 255C79 255 78.6 251.6 81.4 250L86.4 248.6Z', { fill: 'shoe', stroke: 'shoeLine', strokeWidth: 1 }),
      path('M86.8 243.4L97.8 243', { stroke: 'shoeLine', strokeWidth: 1.6 }),
      ellipse(95.6, 243.2, 1.1, 1.1, { fill: 'moon' }),
      path('M80 252.6C83 254 92 254.4 97.6 253.4', { stroke: '#ffffff', strokeWidth: 0.8, opacity: 0.3 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M74 194L126 194L134.6 230C122 235 78 235 65.4 230Z', { fill: 'skirtGrad', stroke: 'skirtLine', strokeWidth: 1.1 }),
      path('M85 196L79 233M100 196L100 234.6M115 196L121 233', { stroke: 'plaidA', strokeWidth: 1.6, opacity: 0.55 }),
      path('M92.5 196L89.6 234M107.5 196L110.4 234', { stroke: 'plaidA', strokeWidth: 0.7, opacity: 0.5 }),
      path('M71 208C86 210.6 114 210.6 129 208M68 220C84 223.4 116 223.4 132 220', { stroke: 'plaidB', strokeWidth: 1.1, opacity: 0.55 }),
      path('M66.4 228.4C80 232.4 120 232.4 133.6 228.4', { stroke: 'plaidB', strokeWidth: 0.9, opacity: 0.8 }),
    ]),
    part('torso', 'body', 20, [
      path('M72 148C74 139 86 137 100 137C114 137 126 139 128 148L132 194C132 199 128 201 122 201L78 201C72 201 68 199 68 194Z', { fill: 'cardi', stroke: 'cardiLine', strokeWidth: 1.1 }),
      path('M92 141L100 150L108 141L106.4 201L93.6 201Z', { fill: 'blouse', stroke: 'cardiLine', strokeWidth: 0.8 }),
      path('M72 148C70 162 69 178 68.4 194C68.6 198 70.6 200 73.6 200.6C72.6 186 73.4 166 76.4 150Z', { fill: 'cardiShade' }),
      path('M128 148C130 162 131 178 131.6 194C131.4 198 129.4 200 126.4 200.6C127.4 186 126.6 166 123.6 150Z', { fill: 'cardiShade', opacity: 0.7 }),
      path('M68.6 193.6C76 196 88 196.6 93.8 196.4M106.2 196.4C112 196.6 124 196 131.4 193.6', { stroke: 'cardiLine', strokeWidth: 0.8, opacity: 0.7 }),
      ellipse(91, 165, 1.4, 1.4, { fill: 'cardiLine' }),
      ellipse(91.4, 178, 1.4, 1.4, { fill: 'cardiLine' }),
      ellipse(91.8, 191, 1.4, 1.4, { fill: 'cardiLine' }),
      path('M80 178L88 178L88 186C86 188 82 188 80 186Z', { stroke: 'cardiLine', strokeWidth: 0.8, opacity: 0.6 }),
    ]),
    part('neck', 'body', 21, [
      path('M93 126L93 142C96 144.5 104 144.5 107 142L107 126Z', { fill: 'skin' }),
      path('M93 129C96 135.5 104 135.5 107 129L107 138C104 141 96 141 93 138Z', { fill: 'skinShade' }),
    ]),
    part('collar', 'body', 22, [
      path('M88 139.4C90 145 95 149.4 100 149.4L100 143C96 143 91.6 141.6 89.6 138.6Z', { fill: 'blouse', stroke: 'cardiLine', strokeWidth: 0.8 }),
      path('M112 139.4C110 145 105 149.4 100 149.4L100 143C104 143 108.4 141.6 110.4 138.6Z', { fill: 'blouse', stroke: 'cardiLine', strokeWidth: 0.8 }),
      ...bow({ at: [100, 148], scale: 0.85, tails: 8 }),
    ]),
    part('book', 'body', 25, [
      path('M83 178L100 181L117 178L118 192.4L100 195.6L82 192.4Z', { fill: 'bookCover', stroke: 'bookLine', strokeWidth: 1 }),
      path('M85.2 176.6C91 175 96 176.2 100 179.4C104 176.2 109 175 114.8 176.6L115.6 189.8C110.4 188.8 104.8 189.6 100 192.6C95.2 189.6 89.6 188.8 84.4 189.8Z', { fill: 'page', stroke: 'pageLine', strokeWidth: 0.7 }),
      path('M88 180.4C91 179.8 94 180.2 97 181.4M88 183.6C91 183 94 183.4 97 184.6M88 186.8C90.6 186.2 93 186.6 95 187.4M103 181.4C106 180.2 109 179.8 112 180.4M103 184.6C106 183.4 109 183 112 183.6', { stroke: 'pageLine', strokeWidth: 0.7 }),
      path('M100 179.4L100 192.6', { stroke: 'pageLine', strokeWidth: 0.8 }),
      path('M101 192.8L100.4 202L102 200.4L103.4 202.2L102.8 192.6Z', { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.5 }),
      ellipse(86.6, 186.4, 3.4, 2.6, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: -30 }),
      ellipse(113.4, 186.4, 3.4, 2.6, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: 30 }),
    ], { slot: 'hand:book' }),
    ...arms({ shoulder: [77, 146], radius: [9.4, 8.4, 9.8], sleeve: 'cardi', shade: 'cardiShade', line: 'cardiLine', cuff: 'cardiLine', cuffBands: 2 }),

    // Face.
    ...pair('ear', 'head', 18, [
      ellipse(60.4, 100, 4.4, 6.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      ellipse(61.2, 100.6, 1.9, 3.4, { fill: 'skinShade' }),
    ]),
    part('face', 'head', 20, [
      path(face, { fill: 'skinGrad', stroke: 'skinLine', strokeWidth: 1 }),
      path('M99.4 117.4L100.6 118.6', { stroke: 'skinLine', strokeWidth: 1.1, opacity: 0.6 }),
    ]),
    ...blush({ at: [72, 117.6], scale: 0.95 }),
    ...eye.parts,
    ...mouths({ at: [100, 125.4], scale: 0.9 }),
    part('bangShadow', 'head', 47, [path(shift(bangs, 0, 4), { fill: 'skinShade', opacity: 0.5, blend: 'multiply' })], { clip: 'face' }),

    // Front hair: a long lock on the left, the braid on the right.
    part('lockL', 'head', 48, [
      path('M62 64C49 90 47 128 50 160C51.4 170 56 175 60 169C58.4 140 60 110 71 82Z', hairPaint),
      path('M58 88C54 110 53 136 54.6 160', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
    ], { pivot: [64, 66], spring: { stiffness: 0.1, damping: 0.86, gain: 0.9, limit: 10, hang: 0.6 } }),
    part('lockR', 'head', 48, [
      path('M138 64C148 82 150 98 149 108C147 110 143 109 141 106C141 96 138 86 130 78Z', hairPaint),
    ]),
    part('braid', 'head', 47.5, [
      ...braid,
      path('M141.6 190.6C140 196 141 200 143.6 203.4C144.6 199.6 146.6 198 148.4 197C147 194.6 146.6 192.4 146.6 190.2Z', hairPaint),
      ...bow({ at: [144.4, 189.2], scale: 0.9, tails: 10 }),
      path('M144.6 191L143.4 210.6L145.2 208.6L146.8 211L147.6 191.4Z', { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.6 }),
    ], { pivot: [144, 100], spring: { stiffness: 0.06, damping: 0.88, gain: 1.1, limit: 12, hang: 0.8 } }),
    part('bangs', 'head', 50, [
      path(bangs, { fill: 'hairGrad' }),
      path(`M146 100${bangsEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M124 70C120 80 116 86 113 91M96 70C92 79 89 85 86 90M110 68C106 80 102 88 98 95', { stroke: 'hairShade', strokeWidth: 0.9, opacity: 0.6 }),
      path('M133 33C116 39 104 55 100 71C98 79 97 87 96 96C101.4 84 104.4 76 108.4 66C114 54 122 45.4 135 41Z', { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 0.9 }),
      path('M126 40C116 48 108 60 104 72', { stroke: 'hairShine', strokeWidth: 1.2, opacity: 0.8 }),
    ]),
    part('shine', 'head', 51, [
      path('M64 63C68 52 76 45 86.4 41.6C82 46 76.4 52.4 70.2 63.6Z', { fill: 'hairShine', opacity: 0.85 }),
      path('M90.4 40.4C96.6 38.8 103.4 38.8 109.6 40.4C103.4 43.2 96.6 43.2 90.4 40.4Z', { fill: 'hairShine', opacity: 0.85 }),
      path('M136 63C132 52 124 45 113.6 41.6C118 46 123.6 52.4 129.8 63.6Z', { fill: 'hairShine', opacity: 0.85 }),
    ]),
    part('moonPin', 'head', 54, moon.shapes([
      path('M0 -7C-5.6 -5.6 -7 2 -3 6C0.6 9.4 6 7.6 7 4.6C3.4 6 -0.6 4.6 -2 1C-3.2 -2.2 -2.2 -5.4 0 -7Z', { fill: 'moon', stroke: 'moonLine', strokeWidth: 0.9 }),
      ellipse(4.6, -3.6, 1.2, 1.2, { fill: 'moon', stroke: 'moonLine', strokeWidth: 0.5 }),
    ])),
    ...brows({ at: [78.6, 82.6], tilt: 3 }),
  ],
};
