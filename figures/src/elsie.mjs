// Elsie: a quiet, polite girl from the United Kingdom.
// A honey-blonde bob with blunt bangs, freckles, blue-green eyes; a camel duffle coat
// with toggles, a red tartan scarf, white knee socks and Mary Janes. She
// sips tea while idle and floats down under her umbrella when she falls.
import { arms, around, blush, brows, ellipse, eyes, mouths, pair, part, path, strands, transformer } from './kit.mjs';

const face = 'M58 86C57 110 72 127 90 131.5Q100 134.5 110 131.5C128 127 143 110 142 86C141 58 124 44 100 44C76 44 59 58 58 86Z';

// Blunt bangs with small, soft tips.
const edge = (dy) => strands([
  [147, 98 + dy], [141, 96 + dy], [136, 84 + dy], [129, 90 + dy], [122, 84 + dy], [114, 90 + dy], [107, 84 + dy], [100, 90 + dy],
  [93, 84 + dy], [86, 90 + dy], [79, 84 + dy], [71, 90 + dy], [64, 84 + dy], [59, 96 + dy], [53, 98 + dy],
]);
const bangsEdge = edge(-3);

const eye = eyes({ at: [79, 104.6], scale: 1.08, tilt: 2, height: 1, style: 'gentle' });
const hairPaint = { fill: 'hairGrad', stroke: 'hairLine', strokeWidth: 1.2 };

// Umbrella held in the raised right hand; the canopy is drawn upright at the
// origin and turned to line up with the shaft.
const hand = [151.2, 114];
const tip = [130.3, 6];
const tilt = (Math.atan2(tip[0] - hand[0], hand[1] - tip[1]) * 180) / Math.PI;
const canopy = transformer({ at: tip, scale: 1, tilt });
const toggle = (y) => [
  path(`M88 ${y}L94 ${y}`, { stroke: 'toggleRope', strokeWidth: 1 }),
  ellipse(91, y, 3.6, 1.3, { fill: 'toggle', stroke: 'toggleLine', strokeWidth: 0.6 }),
];

export default {
  format: 'peetty.figure',
  version: 1,
  id: 'elsie',
  name: { en: 'Elsie', zh: '艾尔西', ja: 'エルシー' },
  description: {
    en: 'Quiet and polite. Sits down for a cup of tea and floats down gently under her umbrella.',
    zh: '安静有礼貌，喜欢坐下来喝杯茶，掉下来时会撑开小伞慢慢飘落。',
  },
  author: 'Peetty',
  license: 'CC-BY-4.0',
  renderer: 'rig',
  viewBox: [0, 0, 200, 260],
  height: 118,
  anchor: [100, 256],
  behavior: { weights: { idle: 4, sit: 4, walk: 1.5, jump: 1, lie: 1, sleep: 1 }, walkSpeed: 0.85, jumpPower: 0.95, idleProp: 'cup', fallProp: 'umbrella' },
  sounds: {
    volume: 0.26, cooldown: 1,
    events: {
      wave: [{ notes: [698, 880, 1047], duration: 0.1 }],
      jump: [{ notes: [349, 523], duration: 0.08 }],
      land: [{ notes: [175, 131], duration: 0.055, volume: 0.45 }],
      drag: [{ notes: [880, 698], duration: 0.095 }],
      sleep: [{ notes: [523, 440, 349], duration: 0.16, volume: 0.55 }],
      wake: [{ notes: [349, 523, 698], duration: 0.11 }],
      talk: [{ notes: [698, 880], duration: 0.055, volume: 0.35 }],
    },
  },
  palette: {
    skin: '#fff4ee', skinShade: '#f3d3c8', skinLine: '#dba596', blush: '#ffa0ab', blushLine: '#ee7f8c', freckle: '#c98f63',
    lash: '#4a3528', sclera: '#ffffff', eyeShade: '#dfe5ea',
    irisDark: '#1e5662', iris: '#3c97a3', irisLight: '#9fe0d8', irisGlow: '#e8fffb', pupil: '#133840',
    mouth: '#9a4057', mouthLine: '#8d3a4c', tongue: '#ffa3b0', brow: '#a57c48',
    hair: '#f2d39a', hairMid: '#ddb46f', hairTip: '#c99a55', hairShade: '#b5853f', hairDeep: '#9d7032', hairLine: '#8a6229', hairShine: '#fff6dc',
    coat: '#cf9e66', coatShade: '#b5844e', coatLine: '#8a6036', toggle: '#f3e6cc', toggleLine: '#a88a5c', toggleRope: '#6b4a2a',
    scarf: '#c8343f', scarfDeep: '#9f2531', scarfLine: '#7c1c26', tartanA: '#1f5f4a', tartanB: '#f5d36b',
    skirt: '#3a3f58', skirtLine: '#24283a',
    sock: '#ffffff', sockLine: '#c9c4d6', shoe: '#2b2129', shoeLine: '#150f14',
    china: '#ffffff', chinaLine: '#9fa8c2', chinaBlue: '#4c6fc1', tea: '#b9773e', steam: '#ffffff',
    canopy: '#2e3555', canopyLight: '#46507a', canopyLine: '#191d33', shaft: '#8a6036', ferrule: '#d6c9a8',
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
    hairGrad: { type: 'linear', from: [0, 16], to: [0, 140], stops: [{ offset: 0, color: 'hair' }, { offset: 0.5, color: 'hairMid' }, { offset: 1, color: 'hairTip' }] },
    skinGrad: { type: 'linear', from: [0, 60], to: [0, 134], stops: [{ offset: 0, color: 'skin' }, { offset: 1, color: '#ffeee6' }] },
  },
  clips: { ...eye.clips, face: [path(face)] },
  parts: [
    // A rounded bob, behind the face.
    part('hairBack', 'head', 4, [
      path('M49 96C43 52 72 18 100 18C128 18 157 52 151 96C151 112 149 124 144 132C140 137 133 137 130 133C129 131 128 130 126 129L74 129C72 130 71 131 70 133C67 137 60 137 56 132C51 124 49 112 49 96Z', hairPaint),
      path('M62 124C78 129 122 129 138 124L137 129C122 133 78 133 63 129Z', { fill: 'hairDeep', opacity: 0.4 }),
    ]),
    part('hood', 'body', 16, [path('M74 145C76 130 124 130 126 145C116 150 84 150 74 145Z', { fill: 'coatShade', stroke: 'coatLine', strokeWidth: 1 })]),

    // Body.
    ...pair('leg', 'hips', 10, [
      path('M88 208L87 238C87 241 97 241 97 238L98 208Z', { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      path('M87.6 220L97.6 220L97.2 239L87.1 239Z', { fill: 'sock', stroke: 'sockLine', strokeWidth: 0.6 }),
      path('M87.6 222.4L97.6 222.4', { stroke: 'sockLine', strokeWidth: 0.8 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    ...pair('shoe', 'hips', 12, [
      path('M86.4 239C86.4 236.2 98 236.2 98 239L98.6 249C99 253 98 255 95 255L83 255C79 255 78.6 251.6 81.4 250L86.4 248.6Z', { fill: 'shoe', stroke: 'shoeLine', strokeWidth: 1 }),
      path('M86.6 242.6L97.8 242.2', { stroke: 'shoeLine', strokeWidth: 1.8 }),
      ellipse(95.4, 242.4, 1.1, 1.1, { fill: 'ferrule' }),
      path('M80 252.6C83 254 92 254.4 97.6 253.4', { stroke: '#ffffff', strokeWidth: 0.8, opacity: 0.3 }),
    ], { boneL: 'legL', boneR: 'legR' }),
    part('skirt', 'hips', 18, [
      path('M76 190L124 190L132 212C122 216 78 216 68 212Z', { fill: 'skirt', stroke: 'skirtLine', strokeWidth: 1.1 }),
      path('M87 192L82 214M100 192L100 215.4M113 192L118 214', { stroke: 'skirtLine', strokeWidth: 0.9, opacity: 0.7 }),
    ]),
    part('torso', 'body', 20, [
      // The coat flares a little below the waist, like a short duffle.
      path('M73 148C75 139 86 137 100 137C114 137 125 139 127 148L132 190C133 197 128 201 121 201L79 201C72 201 67 197 68 190Z', { fill: 'coat', stroke: 'coatLine', strokeWidth: 1.1 }),
      path('M73 148C71 162 69.6 176 68.6 190C68.6 195 71 198.6 75 200C74 186 74.6 164 77.4 150Z', { fill: 'coatShade' }),
      path('M127 148C129 162 130.4 176 131.4 190C131.4 195 129 198.6 125 200C126 186 125.4 164 122.6 150Z', { fill: 'coatShade', opacity: 0.6 }),
      path('M100 146L100 200.6', { stroke: 'coatLine', strokeWidth: 0.9, opacity: 0.8 }),
      path('M100 146C103 160 103.6 180 103 200.6', { stroke: 'coatLine', strokeWidth: 0.7, opacity: 0.5 }),
      ...toggle(160), ...toggle(174), ...toggle(188),
      path('M77 178L87 178L87 188C85 190 79 190 77 188Z', { stroke: 'coatLine', strokeWidth: 0.8, opacity: 0.6 }),
      path('M113 178L123 178L123 188C121 190 115 190 113 188Z', { stroke: 'coatLine', strokeWidth: 0.8, opacity: 0.6 }),
    ]),
    part('neck', 'body', 21, [
      path('M93 126L93 142C96 144.5 104 144.5 107 142L107 126Z', { fill: 'skin' }),
      path('M93 129C96 135.5 104 135.5 107 129L107 138C104 141 96 141 93 138Z', { fill: 'skinShade' }),
    ]),
    part('scarf', 'body', 22, [
      path('M84 136C88 131 112 131 116 136L117 145C112 150 88 150 83 145Z', { fill: 'scarf', stroke: 'scarfLine', strokeWidth: 1 }),
      path('M84 140C92 143.6 108 143.6 116 140M98 133L97.4 148M106 133L106.6 148M90 134L89 147', { stroke: 'tartanA', strokeWidth: 1.4, opacity: 0.9 }),
      path('M84.4 142.6C92 146 108 146 115.6 142.6', { stroke: 'tartanB', strokeWidth: 0.6, opacity: 0.9 }),
    ]),
    part('scarfTail', 'body', 22.5, [
      path('M104 144L114 144L116 172L104 173Z', { fill: 'scarf', stroke: 'scarfLine', strokeWidth: 1 }),
      path('M104.4 152L115 151.6M104.6 162L115.6 161.6M109 144.4L110 172.6', { stroke: 'tartanA', strokeWidth: 1.4, opacity: 0.9 }),
      path('M104.4 156L115.2 155.8', { stroke: 'tartanB', strokeWidth: 0.6, opacity: 0.9 }),
      path('M105 173L104.6 177M108 173L107.8 177.4M111 173L111 177.4M114 172.6L114.6 176.8', { stroke: 'scarfDeep', strokeWidth: 1.2 }),
    ], { pivot: [108, 145], spring: { stiffness: 0.12, damping: 0.84, gain: 1.4, limit: 14, hang: 0.75 } }),
    part('teacup', 'body', 25, [
      ellipse(100, 191, 13, 3.2, { fill: 'china', stroke: 'chinaLine', strokeWidth: 0.9 }),
      ellipse(100, 190.4, 8, 1.8, { stroke: 'chinaBlue', strokeWidth: 0.7, opacity: 0.6 }),
      path('M108 176C114 175 115.6 182.4 108.6 184.4', { stroke: 'chinaLine', strokeWidth: 2.2 }),
      path('M108 176C114 175 115.6 182.4 108.6 184.4', { stroke: 'china', strokeWidth: 1 }),
      path('M90.4 174L109.6 174C109.4 182 106 189.4 100 189.4C94 189.4 90.6 182 90.4 174Z', { fill: 'china', stroke: 'chinaLine', strokeWidth: 0.9 }),
      path('M91.4 179.4C97 181 103 181 108.6 179.4', { stroke: 'chinaBlue', strokeWidth: 1.4 }),
      ellipse(95, 183.6, 1, 1, { fill: 'chinaBlue' }), ellipse(100, 184.6, 1, 1, { fill: 'chinaBlue' }), ellipse(105, 183.6, 1, 1, { fill: 'chinaBlue' }),
      ellipse(100, 174, 9.6, 2, { fill: 'tea', stroke: 'chinaLine', strokeWidth: 0.8 }),
      path('M96 170C94 166 98 164 96 160M103 169C101.4 165.4 105 163.4 103.4 159.4', { stroke: 'steam', strokeWidth: 1.2, opacity: 0.7 }),
      ellipse(92, 186, 3.4, 2.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: -25 }),
      ellipse(108.4, 186, 3.4, 2.8, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.7, rotate: 25 }),
    ], { slot: 'hand:cup' }),
    ...arms({ shoulder: [77, 146], radius: [10.4, 9.4, 11], sleeve: 'coat', shade: 'coatShade', line: 'coatLine', cuff: 'coatLine', cuffBands: 1 }),
    part('umbrella', 'armR', 55, [
      path(`M${hand[0] + 0.4} ${hand[1] + 2}C${hand[0] + 1.4} ${hand[1] + 11} ${hand[0] + 9} ${hand[1] + 11} ${hand[0] + 9} ${hand[1] + 5}`, { stroke: 'shaft', strokeWidth: 2.6 }),
      path(`M${hand[0]} ${hand[1]}L${tip[0]} ${tip[1]}`, { stroke: 'shaft', strokeWidth: 1.8 }),
      ...canopy.shapes([
        path('M-58 0C-56 -42 56 -42 58 0C52 -6 41 -6 35 0C29 -6 17 -6 11.6 0C6 -6 -6 -6 -11.6 0C-17 -6 -29 -6 -35 0C-41 -6 -52 -6 -58 0Z', { fill: 'canopy', stroke: 'canopyLine', strokeWidth: 1.2 }),
        path('M-35 0C-30 -18 -14 -32 0 -34C-12 -26 -18 -14 -11.6 0M35 0C30 -18 14 -32 0 -34C12 -26 18 -14 11.6 0', { stroke: 'canopyLine', strokeWidth: 0.9, opacity: 0.8 }),
        path('M-46 -12C-40 -26 -26 -32 -16 -33', { stroke: 'canopyLight', strokeWidth: 2.4, opacity: 0.9 }),
        path('M0 -34L0 -42', { stroke: 'ferrule', strokeWidth: 2 }),
      ]),
      ellipse(hand[0], hand[1] + 1, 4.2, 4.6, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
    ], { slot: 'hand:umbrella' }),

    // Face.
    ...pair('ear', 'head', 18, [
      ellipse(58.6, 100, 4.6, 7, { fill: 'skin', stroke: 'skinLine', strokeWidth: 0.8 }),
      ellipse(59.4, 100.6, 2, 3.6, { fill: 'skinShade' }),
    ]),
    part('face', 'head', 20, [
      path(face, { fill: 'skinGrad', stroke: 'skinLine', strokeWidth: 1 }),
      path('M99.4 117.6L100.6 118.8', { stroke: 'skinLine', strokeWidth: 1.1, opacity: 0.6 }),
    ]),
    ...blush({ at: [71.4, 118.4], scale: 0.95 }),
    ...pair('freckles', 'head', 39.5, [
      ellipse(70.4, 114.2, 0.9, 0.8, { fill: 'freckle', opacity: 0.8 }),
      ellipse(74.2, 112.8, 0.8, 0.7, { fill: 'freckle', opacity: 0.8 }),
      ellipse(77.8, 114.6, 0.9, 0.8, { fill: 'freckle', opacity: 0.8 }),
      ellipse(72.4, 116.8, 0.7, 0.65, { fill: 'freckle', opacity: 0.7 }),
      ellipse(76, 117.6, 0.65, 0.6, { fill: 'freckle', opacity: 0.65 }),
      ellipse(81.6, 112.6, 0.6, 0.55, { fill: 'freckle', opacity: 0.6 }),
    ]),
    ...eye.parts,
    ...mouths({ at: [100, 125.6], scale: 0.9 }),
    part('bangShadow', 'head', 47, [path(`M53 99C49 60 70 26 100 26C130 26 151 60 147 99${edge(1)}Z`, { fill: 'skinShade', opacity: 0.5, blend: 'multiply' })], { clip: 'face' }),

    // Front hair: straight side pieces ending at the jaw, blunt bangs.
    ...pair('side', 'head', 48, [
      path('M60 66C49 88 47 112 51 129C53.6 136 63 137.6 68 133C63 132 61.6 126 62 116C62.6 104 64 90 72 76Z', hairPaint),
      path('M57 92C54 106 54 120 55.6 132', { stroke: 'hairShade', strokeWidth: 1, opacity: 0.7 }),
      path('M53.4 100C52.6 108 52.6 116 53.6 122', { stroke: 'hairShine', strokeWidth: 1.6, opacity: 0.6 }),
    ], { pivot: [63, 68], spring: { stiffness: 0.14, damping: 0.83, gain: 0.9, limit: 9, hang: 0.5 } }),
    part('bangs', 'head', 50, [
      path(`M53 95C49 58 70 24 100 24C130 24 151 58 147 95${bangsEdge}Z`, { fill: 'hairGrad' }),
      path(`M147 95${bangsEdge}`, { stroke: 'hairLine', strokeWidth: 1.2 }),
      path('M93 81C92 85 91 87 89 88M107 81C108 85 109 87 111 88', { stroke: 'hairShade', strokeWidth: 0.9, opacity: 0.6 }),
      path('M100 26C96 40 92 56 88 72M100 26C105 40 110 56 114 72M78 36C72 48 68 60 66 74M122 36C128 48 132 60 134 74', { stroke: 'hairShade', strokeWidth: 0.9, opacity: 0.45 }),
    ]),
    part('shine', 'head', 51, [
      path('M64 63C68 52 76 45 86.4 41.6C82 46 76.4 52.4 70.2 63.6Z', { fill: 'hairShine', opacity: 0.55 }),
      path('M90.4 40.4C96.6 38.8 103.4 38.8 109.6 40.4C103.4 43.2 96.6 43.2 90.4 40.4Z', { fill: 'hairShine', opacity: 0.55 }),
      path('M136 63C132 52 124 45 113.6 41.6C118 46 123.6 52.4 129.8 63.6Z', { fill: 'hairShine', opacity: 0.55 }),
    ]),
    part('hairClip', 'head', 53, around([128, 60], { tilt: 30 }, [
      path('M118 58L138 58C140 58 140 62 138 62L118 62C116 62 116 58 118 58Z', { fill: 'scarf', stroke: 'scarfLine', strokeWidth: 0.8 }),
      path('M122 58L122 62M126 58L126 62M130 58L130 62M134 58L134 62', { stroke: 'tartanA', strokeWidth: 1 }),
    ])),
    ...brows({ at: [78.4, 82.4], tilt: 2 }),
  ],
};
