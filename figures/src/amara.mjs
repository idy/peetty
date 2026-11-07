// Amara: a curious girl from the United States who photographs everything
// she finds. Deep brown skin, two curly afro puffs tied with sunflower-yellow
// bands, a soft curly fringe, amber eyes; a striped long-sleeve tee under a
// coral pinafore with a print pocket, lilac high-tops and a little camera.
import { arms, blush, brows, ellipse, eyes, mouths, pair, part, path } from './kit.mjs';

const r = (n) => +n.toFixed(2);
const face = 'M58 86C57 110 72 127 90 131.5Q100 134.5 110 131.5C128 127 143 110 142 86C141 58 124 44 100 44C76 44 59 58 58 86Z';

/** A puff of coily hair: a circle of soft, round bumps. */
function puff(cx, cy, rad, bumps = 12, depth = 2.6, turn = 0.2) {
  const at = (a, k) => `${r(cx + Math.cos(a) * k)} ${r(cy + Math.sin(a) * k)}`;
  let d = `M${at(turn, rad)}`;
  for (let i = 1; i <= bumps; i++) {
    const a = turn + (i / bumps) * Math.PI * 2;
    d += `Q${at(a - Math.PI / bumps, rad + depth * 2)} ${at(a, rad)}`;
  }
  return `${d}Z`;
}

/** Little curl marks that give the puffs their texture. */
function curls(cx, cy, rad) {
  let d = '';
  for (const [a, k] of [[0.4, 0.55], [1.4, 0.4], [2.5, 0.6], [3.5, 0.35], [4.4, 0.62], [5.4, 0.45], [0, 0]]) {
    const x = cx + Math.cos(a) * rad * k;
    const y = cy + Math.sin(a) * rad * k;
    d += `M${r(x - 2.4)} ${r(y)}C${r(x - 2.4)} ${r(y - 3)} ${r(x + 2.4)} ${r(y - 3)} ${r(x + 2.4)} ${r(y)}`;
  }
  return d;
}

// A curly fringe: round curls instead of pointed strands.
const scallop = (dy) => {
  const pts = [[146, 96], [139, 83], [128, 86], [117, 83], [106, 87], [95, 83], [84, 86], [73, 83], [62, 86], [54, 96]];
  let d = '';
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const side = i === 1 || i === pts.length - 1;
    d += `Q${r((x0 + x1) / 2)} ${r(Math.max(y0, y1) + (side ? 2 : 7.5) + dy)} ${x1} ${y1 + dy}`;
  }
  return d;
};
const fringeEdge = scallop(0);

const eye = eyes({ at: [78.6, 104], scale: 1.1, tilt: -4, height: 1.04, style: 'bright' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'amara',
  name: { en: 'Amara', zh: '阿玛拉', ja: 'アマラ' },
  description: {
    en: 'Curious about everything. Hops from card to card with her camera and snaps whatever catches her eye.',
    zh: '对什么都好奇，带着相机在卡片之间跳来跳去，看到喜欢的就拍下来。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 120,
  anchor: [100, 256],
  behavior: { weights: { walk: 3, jump: 3, idle: 4, wave: 1.5, sit: 2, sleep: 0.5 }, walkSpeed: 1.15, jumpPower: 1.15, idleProp: 'camera' },
  palette: {
    skin: '#9a6444', skinShade: '#7e4e34', skinLine: '#5e3523', blush: '#e2626e', blushLine: '#ffa3ab',
    lash: '#1d1210', sclera: '#ffffff', eyeShade: '#d8c4bf',
    irisDark: '#5a2b0e', iris: '#b5682a', irisLight: '#ffc56e', irisGlow: '#fff1d4', pupil: '#2e1406',
    mouth: '#6b2433', mouthLine: '#4a1822', tongue: '#e8848f', brow: '#24160f',
    hair: '#4a3330', hairMid: '#3a2826', hairTip: '#2c1e1d', hairShade: '#1a1110', hairDeep: '#140d0c', hairLine: '#120b0a', hairShine: '#a98274',
    tie: '#ffc93c', tieLine: '#c9921e',
    tee: '#fff8ec', teeShade: '#ecdfc9', teeLine: '#b9a88c', stripe: '#5b9be0',
    dress: '#ff7f6e', dressDeep: '#e5604f', dressLine: '#b4473a', button: '#ffe08a', printA: '#ffc93c', printB: '#2e8f7a',
    shoe: '#b9a3ee', shoeLine: '#6c56a8', sole: '#ffffff', lace: '#ffffff',
    cam: '#7fd3c0', camDeep: '#4fae99', camLine: '#2f7a6a', lens: '#2b2c3a', lensGlass: '#5a6aa8', strap: '#2e8f7a',
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
    hairGrad: { type: 'linear', from: [0, 10], to: [0, 110], stops: [{ offset: 0, color: 'hair' }, { offset: 0.5, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 134], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#935e3f' }] },
    dressGrad: { type: 'linear', from: [0, 186], to: [0, 218], stops: [{ offset: 0, color: 'dress' }, { offset: 1, color: 'dressDeep' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // Two puffs, then the hair pulled back behind the face.
    ...pair('puff', 'head', 5, [
      path(puff(52, 32, 19), hairPaint),
      path(curls(52, 32, 19), { stroke: 'hairShade', strokeWidth: 1, opacity: 0.75 }),
      path('M40 24C43 18 50 15 56 16', { stroke: 'hairShine', strokeWidth: 1.8, opacity: 0.5 }),
    ], { pivot: [64, 44], spring: { stiffness: 0.12, damping: 0.82, gain: 1.1, limit: 8, hang: 0.3 } }),
    part('hairBack', 'head', 4, [
      path('M48 94C42 44 74 14 100 14C126 14 158 44 152 94C152 106 149 114 144 120L56 120C51 114 48 106 48 94Z', hairPaint),
    ]),

    // Body.
    ...pair('leg', 'hips', 10, [
      path('M88 208L87 238C87 241 97 241 97 238L98 208Z', { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('shoe', 'hips', 12, [
      path('M86 230C86 227.4 98.2 227.4 98.2 230L98.8 247.6C99.4 251.6 98.2 254.6 95.2 254.6L80.4 254.6C76.4 254.6 75.8 250.6 79.4 248.8L86 246.6Z', { fill: 'shoe', stroke: 'shoeLine', strokeWidth: 1 }),
      path('M76.6 252.4C80 255.8 96 256 99.4 252.2', { stroke: 'sole', strokeWidth: 2.4 }),
      path('M89 233L95.4 233M88.8 236.6L95.6 236.6M88.6 240.2L95.8 240.2', { stroke: 'lace', strokeWidth: 0.9 }),
      ellipse(92.4, 244.6, 3.2, 2.4, { fill: 'sole', stroke: 'shoeLine', strokeWidth: 0.6 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M74 189L126 189L139 214C128 219.5 72 219.5 61 214Z', { fill: 'dressGrad', stroke: 'dressLine', strokeWidth: 1.1 }),
      path('M86 191L79.5 216.8M100 191L100 218.4M114 191L120.5 216.8', { stroke: 'dressLine', strokeWidth: 0.9, opacity: 0.6 }),
      path('M64.5 210.5C76 214.6 124 214.6 135.5 210.5', { stroke: 'printA', strokeWidth: 1.4 }),
    ]),
    part('torso', 'body', 20, [
      path('M72 148C74 139 86 137 100 137C114 137 126 139 128 148L132 186C133 192 129 195 123 195L77 195C71 195 67 192 68 186Z', { fill: 'tee', stroke: 'teeLine', strokeWidth: 1.1 }),
      path('M71.4 156L128.6 156M70.6 165L129.4 165M69.8 174L130.2 174M69 183L131 183', { stroke: 'stripe', strokeWidth: 2.2, opacity: 0.85 }),
      // Pinafore bib, straps and a pocket with a small geometric print.
      path('M84 155L116 155L118.4 195L81.6 195Z', { fill: 'dress', stroke: 'dressLine', strokeWidth: 1 }),
      path('M84.6 156L80.6 140M115.4 156L119.4 140', { stroke: 'dress', strokeWidth: 4.4 }),
      path('M84.6 156L80.6 140M115.4 156L119.4 140', { stroke: 'dressLine', strokeWidth: 0.6, opacity: 0.6 }),
      ellipse(85.2, 157.6, 1.9, 1.9, { fill: 'button', stroke: 'dressLine', strokeWidth: 0.6 }),
      ellipse(114.8, 157.6, 1.9, 1.9, { fill: 'button', stroke: 'dressLine', strokeWidth: 0.6 }),
      path('M91 170L109 170L109 182C109 184 107.4 185 105.4 185L94.6 185C92.6 185 91 184 91 182Z', { fill: 'printA', stroke: 'dressLine', strokeWidth: 0.9 }),
      path('M94 172.6L97 175.6L94 178.6L91.4 175.6ZM100 172.6L103 175.6L100 178.6L97 175.6ZM106 172.6L108.6 175.6L106 178.6L103 175.6Z', { fill: 'printB' }),
      path('M91.4 180.6L108.6 180.6', { stroke: 'printB', strokeWidth: 1.4 }),
    ]),
    part('neck', 'body', 21, [
      path('M93 126L93 142C96 144.5 104 144.5 107 142L107 126Z', { fill: 'skin' }),
      path('M93 129C96 135.5 104 135.5 107 129L107 138C104 141 96 141 93 138Z', { fill: 'skinShade' }),
    ]),
    part('collar', 'body', 22, [path('M88.6 139.4C92 145.4 108 145.4 111.4 139.4', { stroke: 'stripe', strokeWidth: 1.8 })]),
    part('camera', 'body', 25, [
      path('M91.6 144L94 168M108.4 144L106 168', { stroke: 'strap', strokeWidth: 1.6 }),
      path('M90 167L95 167L96.6 164.4L103.4 164.4L105 167L110 167C112 167 113 168 113 170L113 184C113 186 112 187 110 187L90 187C88 187 87 186 87 184L87 170C87 168 88 167 90 167Z', { fill: 'cam', stroke: 'camLine', strokeWidth: 1 }),
      path('M87.2 172.6L112.8 172.6', { stroke: 'camDeep', strokeWidth: 1 }),
      ellipse(100, 178, 6.6, 6.6, { fill: 'lens', stroke: 'camLine', strokeWidth: 0.9 }),
      ellipse(100, 178, 4, 4, { fill: 'lensGlass' }),
      ellipse(98.4, 176.4, 1.5, 1.1, { fill: '#ffffff', opacity: 0.85, rotate: -30 }),
      path('M106.6 168.6L110.6 168.6L110.6 170.8L106.6 170.8Z', { fill: '#ffffff', opacity: 0.9 }),
      ellipse(88.4, 181, 3.4, 2.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: -25 }),
      ellipse(111.6, 181, 3.4, 2.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: 25 }),
    ], { slot: 'hand:camera' }),
    ...arms({ shoulder: [77, 146], radius: [10, 9.2, 10.4], sleeve: 'tee', shade: 'teeShade', line: 'teeLine', cuff: 'stripe', cuffWidth: 1.4, cuffBands: 2 }),

    // Face.
    ...pair('ear', 'head', 18, [
      ellipse(58.6, 100, 4.6, 7, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      ellipse(59.4, 100.6, 2, 3.6, { fill: 'skinShade' }),
      ellipse(58.4, 109.4, 1.7, 1.7, { fill: 'tie', stroke: 'tieLine', strokeWidth: 0.5 }),
    ]),
    part('face', 'head', 20, [
      path(face, { fill: 'skinGrad', stroke: 'skinLine', strokeWidth: 1 }),
      path('M99.4 117.6L100.6 118.8', { stroke: 'skinLine', strokeWidth: 1.1, opacity: 0.7 }),
    ]),
    ...blush({ at: [71, 118] }),
    ...eye.parts,
    ...mouths({ at: [100, 125.6] }),
    part('bangShadow', 'head', 47, [path(`M54 100C50 60 72 24 100 24C128 24 150 60 146 100${scallop(4)}Z`, { fill: 'skinShade', opacity: 0.55, blend: 'multiply' })], { clip: 'face' }),

    // Front hair: the curly fringe and the hairline at the temples.
    part('fringe', 'head', 50, [
      path(`M54 96C50 56 72 20 100 20C128 20 150 56 146 96${fringeEdge}Z`, { fill: 'hairGrad' }),
      path(`M146 96${fringeEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M54 96C50 56 72 20 100 20C128 20 150 56 146 96', { stroke: 'hairLine', strokeWidth: 1.2 }),
      path(curls(100, 50, 26), { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
      path('M70 72C68 76 70 80 73 79M130 72C132 76 130 80 127 79', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
    ]),
    part('shine', 'head', 51, [
      path('M72 46C78 38 88 33 98 32C90 36 82 41 77 48Z', { fill: 'hairShine', opacity: 0.45 }),
      path('M128 46C122 38 112 33 102 32C110 36 118 41 123 48Z', { fill: 'hairShine', opacity: 0.45 }),
    ]),
    ...pair('tie', 'head', 53, [
      path('M58.4 46.6C62 41 68.6 38.2 74.6 39.4L76.2 44C70.4 43.6 65 46.4 62.6 50.6Z', { fill: 'tie', stroke: 'tieLine', strokeWidth: 0.9 }),
      path('M62 46C65 43.4 69 42 73 42', { stroke: '#ffffff', strokeWidth: 0.8, opacity: 0.6 }),
    ]),
    ...brows({ at: [78, 81.5], tilt: -3 }),
  ],
};
