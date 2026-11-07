// Drawing kit for the preset figures. Figure sources build plain JSON data
// with these helpers; `npm run figures` writes figures/<id>.json.
//
// Paths here use absolute M, L, C, Q and Z commands only, so every number
// comes in x,y pairs and can be mirrored or transformed safely.

const round = (n) => +n.toFixed(2);

/** Maps every point of absolute M/L/C/Q/Z path data. */
export function mapPath(d, fn) {
  const tokens = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const out = [];
  let nums = [];
  const flush = () => {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const [x, y] = fn(nums[i], nums[i + 1]);
      out.push(`${round(x)} ${round(y)}`);
    }
    nums = [];
  };
  for (const t of tokens) {
    if (/[MLCQZ]/.test(t)) {
      flush();
      out.push(t);
    } else nums.push(Number(t));
  }
  flush();
  return out.join(' ').replace(/ ?([MLCQZ]) ?/g, '$1');
}

export const mirrorX = (d, axis = 100) => mapPath(d, (x, y) => [2 * axis - x, y]);

export function mirrorShape(shape, axis = 100) {
  if (shape.type === 'path') return { ...shape, d: mirrorX(shape.d, axis) };
  const s = { ...shape, cx: round(2 * axis - shape.cx) };
  if (s.rotate) s.rotate = -s.rotate;
  return s;
}

/** Transform: rotate by `tilt` degrees, scale, then move to `at`. */
export function transformer({ at, scale = 1, tilt = 0, sx = 1, sy = 1 }) {
  const r = (tilt * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const point = (x, y) => {
    const X = x * scale * sx, Y = y * scale * sy;
    return [at[0] + X * cos - Y * sin, at[1] + X * sin + Y * cos];
  };
  const shape = (s) => {
    if (s.type === 'path') return { ...s, d: mapPath(s.d, point) };
    const [cx, cy] = point(s.cx, s.cy);
    return { ...s, cx: round(cx), cy: round(cy), rx: round(s.rx * scale * sx), ry: round(s.ry * scale * sy), rotate: round((s.rotate ?? 0) + tilt) || undefined };
  };
  return { point, shape, shapes: (list) => list.map(shape) };
}

export const path = (d, paint = {}) => ({ type: 'path', d, ...paint });
export const ellipse = (cx, cy, rx, ry, paint = {}) => ({ type: 'ellipse', cx, cy, rx, ry, ...paint });

export const part = (id, bone, z, shapes, extra = {}) => ({ id, bone, z, ...extra, shapes });

/** A left part and its mirrored right twin. */
export function pair(id, bone, z, shapes, extra = {}, axis = 100) {
  const right = { ...extra };
  if (extra.pivot) right.pivot = [round(2 * axis - extra.pivot[0]), extra.pivot[1]];
  if (extra.clip) right.clip = `${extra.clip}R`;
  return [
    part(`${id}L`, extra.boneL ?? bone, z, shapes, strip({ ...extra, ...(extra.clip ? { clip: `${extra.clip}L` } : {}) })),
    part(`${id}R`, extra.boneR ?? bone, z, shapes.map((s) => mirrorShape(s, axis)), strip(right)),
  ];
}

function strip(extra) {
  const { boneL, boneR, ...rest } = extra;
  return rest;
}

// ---------------------------------------------------------------------------
// Eyes
//
// One eye is drawn in local units around (0, 0): outer corner at x -13,
// inner corner at x +12. The recipe that makes anime eyes read as cute:
// iris dark at the top and bright at the bottom, the upper lid slightly
// covering the iris, a large and a small highlight, lashes heavier at the
// outer corner with a little flick, and only a hint of lower lash.

const SCLERA = 'M-12 -6C-9 -12.5 6 -13.5 12 -7C13 -1 12 6 9 10.5C5 13.5 -5 13.5 -9 10C-12 6 -13 0 -12 -6Z';

/**
 * @param {object} o
 * @param {[number, number]} o.at left eye center (viewer's left)
 * @param {number} [o.scale]
 * @param {number} [o.tilt] degrees; negative lifts the outer corner
 * @param {number} [o.height] vertical stretch of the iris
 * @param {'bright'|'gentle'|'sleepy'} [o.style]
 */
export function eyes(o) {
  const { at, scale = 1, tilt = 0, height = 1, style = 'bright' } = o;
  const T = transformer({ at, scale, tilt });
  const S = (list) => T.shapes(list);
  const irisRy = 11.6 * height;
  const lid = style === 'sleepy' ? 2.2 : style === 'gentle' ? 1 : 0; // lowers the lash line

  const lashTop = style === 'gentle'
    ? `M-15.6 -6.6C-14.6 -5.8 -13.8 -5.2 -13 -4.4C-9.5 ${-11.8 + lid} 6 ${-13.6 + lid} 13 ${-7 + lid}C13.4 ${-6.4 + lid} 13.1 ${-5.7 + lid} 12.4 ${-5.5 + lid}C6 ${-10.2 + lid} -8 ${-9.8 + lid} -12.6 -1.8C-13.4 -2.4 -14 -3.4 -14.1 -4.8C-14.6 -5.4 -15.2 -6 -15.6 -6.6Z`
    : `M-16.8 -9C-15.2 -7.4 -13.9 -6.6 -13 -5.4C-9.5 ${-12.8 + lid} 6 ${-14.8 + lid} 13 ${-7.6 + lid}C13.4 ${-7 + lid} 13.2 ${-6.2 + lid} 12.4 ${-6 + lid}C6 ${-11.2 + lid} -8 ${-10.6 + lid} -12.6 -2.2C-13.4 -2.8 -14 -4 -14.1 -5.6C-14.9 -6.6 -15.9 -7.8 -16.8 -9Z`;

  const clipShape = path(SCLERA);
  const clips = { eyeL: S([clipShape]), eyeR: S([clipShape]).map((s) => mirrorShape(s)) };

  const lidShade = style === 'sleepy' ? 0.7 : 0.45;
  const open = [
    ...pair('eyeWhite', 'head', 40, S([path(SCLERA, { fill: 'sclera' })]), { slot: 'eyes:open' }),
    ...pair('eyeShade', 'head', 41, S([
      ellipse(0, -11 + lid, 15, 6.5, { fill: 'eyeShade', opacity: lidShade }),
    ]), { slot: 'eyes:open', clip: 'eye' }),
    ...pair('iris', 'head', 42, S([
      ellipse(0.5, 1.6, 9.2, irisRy, { fill: 'irisGrad' }),
      ellipse(0.5, 1.6, 9.2, irisRy, { stroke: 'irisDark', strokeWidth: 0.9, opacity: 0.8 }),
      ellipse(0.5, 2.6, 4.3, 6.2 * height, { fill: 'pupil', opacity: 0.9 }),
      ellipse(0.5, -9.5 + lid, 13, 6.5, { fill: 'irisDark', opacity: 0.55, blend: 'multiply' }),
      path('M-6.5 5.5C-4.5 11.8 5.5 11.8 7.5 5.5C4.5 9.4 -3.5 9.4 -6.5 5.5Z', { fill: 'irisGlow', opacity: 0.9 }),
      ellipse(-3.6, -2.6 + lid * 0.6, 3.4, 4.3, { fill: '#ffffff', rotate: -18 }),
      ellipse(4.6, 7.4, 1.8, 1.6, { fill: '#ffffff', opacity: 0.92 }),
      ellipse(5.2, -3.8 + lid * 0.6, 1, 1, { fill: '#ffffff', opacity: 0.75 }),
    ]), { slot: 'eyes:open', clip: 'eye', look: [2.4, 1.6] }),
    ...pair('lash', 'head', 44, S([
      path(lashTop, { fill: 'lash' }),
      path('M-12.6 -1.6C-14.6 -1.8 -15.8 -3 -16.6 -4.2C-15.2 -3.6 -14 -3 -12.6 -2.8Z', { fill: 'lash' }),
      path('M-9 10.4C-5 13.4 2 13.6 6.2 12.1', { stroke: 'lash', strokeWidth: 0.9, opacity: 0.55 }),
      path('M-10.2 9.2L-11.8 10.4', { stroke: 'lash', strokeWidth: 0.8, opacity: 0.5 }),
      path(`M-11 ${-13.4 + lid}C-5 ${-17.4 + lid} 4 ${-17.4 + lid} 9.5 ${-14.2 + lid}`, { stroke: 'lash', strokeWidth: 0.8, opacity: 0.32 }),
    ]), { slot: 'eyes:open' }),
  ];

  const closed = pair('eyeClosed', 'head', 44, S([
    path('M-12.5 1C-7 5.6 6 5.6 12 0.6', { stroke: 'lash', strokeWidth: 2.1 }),
    path('M-12.5 1L-15.8 -0.6', { stroke: 'lash', strokeWidth: 1.6 }),
    path('M-8 4.2L-9.2 6.4M-3 5.6L-3.4 7.8', { stroke: 'lash', strokeWidth: 0.9, opacity: 0.6 }),
  ]), { slot: 'eyes:closed' });

  const happy = pair('eyeHappy', 'head', 44, S([
    path('M-12 4.5C-8 -4.8 7 -4.8 11 3.6', { stroke: 'lash', strokeWidth: 2.4 }),
    path('M-12 4.5L-14.8 5.6', { stroke: 'lash', strokeWidth: 1.6 }),
  ]), { slot: 'eyes:happy' });

  const sleepy = pair('eyeSleepy', 'head', 44, S([
    path('M-12.5 3.4C-7 7 6 7 12 2.8', { stroke: 'lash', strokeWidth: 1.9 }),
    path('M-12.5 3.4L-15.4 2.4', { stroke: 'lash', strokeWidth: 1.4 }),
    path('M-7.5 6L-8.4 8.2M-2 6.9L-2.2 9.2M4 6.6L4.4 8.8', { stroke: 'lash', strokeWidth: 0.8, opacity: 0.6 }),
  ]), { slot: 'eyes:sleepy' });

  const top = at[1] - 13 * scale * height;
  const bottom = at[1] + 13 * scale * height;
  const gradients = {
    irisGrad: {
      type: 'linear', from: [0, round(top)], to: [0, round(bottom)],
      stops: [
        { offset: 0, color: 'irisDark' },
        { offset: 0.42, color: 'iris' },
        { offset: 0.85, color: 'irisLight' },
        { offset: 1, color: 'irisLight' },
      ],
    },
  };

  return { parts: [...open, ...closed, ...happy, ...sleepy], clips, gradients };
}

/** Brows drawn faintly over the bangs, as anime art often does. */
export function brows({ at, scale = 1, tilt = 0 }) {
  const T = transformer({ at, scale, tilt });
  return [
    ...pair('browCalm', 'head', 52, T.shapes([path('M-9 1C-4 -2 3 -2.4 8 -0.6', { stroke: 'brow', strokeWidth: 1.7, opacity: 0.6 })]), { slot: 'brows:calm' }),
    ...pair('browWorried', 'head', 52, T.shapes([path('M-9 -0.5C-4 -0.8 2 -2.4 7.5 -5', { stroke: 'brow', strokeWidth: 1.7, opacity: 0.65 })]), { slot: 'brows:worried' }),
  ];
}

/** Small mouths; cuteness lives in keeping them tiny and soft. */
export function mouths({ at, scale = 1, cat = false }) {
  const T = transformer({ at, scale });
  const smile = cat
    ? path('M-5.5 -0.6C-4.4 2.4 -1.6 2.6 0 0.4C1.6 2.6 4.4 2.4 5.5 -0.6', { stroke: 'mouthLine', strokeWidth: 1.35 })
    : path('M-4.6 -0.6C-2.4 2.6 2.4 2.6 4.6 -0.6', { stroke: 'mouthLine', strokeWidth: 1.4 });
  return [
    part('mouthSmile', 'head', 46, T.shapes([smile]), { slot: 'mouth:smile' }),
    part('mouthOpen', 'head', 46, T.shapes([
      path('M-5.2 -1.4C-4.4 5.8 4.4 5.8 5.2 -1.4C2 -0.4 -2 -0.4 -5.2 -1.4Z', { fill: 'mouth' }),
      path('M-2.8 3.2C-1.4 1.8 1.6 1.8 3 3.2C1.6 4.6 -1.4 4.6 -2.8 3.2Z', { fill: 'tongue' }),
      path('M-5.2 -1.4C-2 -0.4 2 -0.4 5.2 -1.4', { stroke: 'mouthLine', strokeWidth: 1 }),
    ]), { slot: 'mouth:open' }),
    part('mouthTalk', 'head', 46, T.shapes([
      path('M-3.4 -0.8C-3 3.4 3 3.4 3.4 -0.8C1.4 -0.2 -1.4 -0.2 -3.4 -0.8Z', { fill: 'mouth' }),
      path('M-3.4 -0.8C-1.4 -0.2 1.4 -0.2 3.4 -0.8', { stroke: 'mouthLine', strokeWidth: 1 }),
    ]), { slot: 'mouth:talk' }),
    // A small soft "o": a little wider than tall, flatter on top, dark inside
    // with a hint of tongue. A tall filled oval reads as lipstick, not surprise.
    part('mouthO', 'head', 46, T.shapes([
      path('M-2.3 0.4C-2.3 -0.9 2.3 -0.9 2.3 0.4C2.3 2.2 1.2 3 0 3C-1.2 3 -2.3 2.2 -2.3 0.4Z', { fill: 'mouth' }),
      path('M-1.3 2.3C-0.7 1.8 0.7 1.8 1.3 2.3C0.8 2.8 -0.8 2.8 -1.3 2.3Z', { fill: 'tongue', opacity: 0.9 }),
      path('M-2.3 0.4C-2.3 -0.9 2.3 -0.9 2.3 0.4C2.3 2.2 1.2 3 0 3C-1.2 3 -2.3 2.2 -2.3 0.4Z', { stroke: 'mouthLine', strokeWidth: 0.8 }),
    ]), { slot: 'mouth:o' }),
    part('mouthFlat', 'head', 46, T.shapes([path('M-3.4 0.6C-1.2 1.2 1.2 1.2 3.4 0.4', { stroke: 'mouthLine', strokeWidth: 1.3 })]), { slot: 'mouth:flat' }),
  ];
}

/** Soft blush with a few hatch strokes. */
export function blush({ at, scale = 1 }) {
  const T = transformer({ at, scale });
  return pair('blush', 'head', 39, T.shapes([
    ellipse(0, 0, 8.5, 4.4, { fill: 'blush', opacity: 0.42 }),
    path('M-4.6 -1.2L-6 1.4M-1 -1.4L-2.4 1.2M2.6 -1.4L1.2 1.2', { stroke: 'blushLine', strokeWidth: 0.8, opacity: 0.55 }),
  ]));
}

/**
 * Bangs and other strand edges: alternates tips and partings so tips stay
 * pointed while partings stay soft. `points` runs tip, parting, tip, …
 */
export function strands(points) {
  let d = '';
  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i - 1];
    const [qx, qy] = points[i];
    const toTip = qy > py;
    const c1 = toTip ? [px, py + 0.6 * (qy - py)] : [px + (qx - px) * 0.35, py - 0.3 * (py - qy)];
    const c2 = toTip ? [qx + (px - qx) * 0.18, qy - 0.25 * (qy - py)] : [qx, qy + 0.5 * (py - qy)];
    d += `C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${qx} ${qy}`;
  }
  return d;
}

/** A small bow whose two loops are shaped like browser tabs. */
export function tabBow({ at, scale = 1, tilt = 0 }) {
  const loop = 'M-7 4L-5.4 -4C-5.1 -5.6 -4.1 -6.4 -2.5 -6.4L2.5 -6.4C4.1 -6.4 5.1 -5.6 5.4 -4L7 4Z';
  const dot = (x, y) => ellipse(x, y, 1.1, 1.1, { fill: 'ribbonDeep' });
  const L = transformer({ at: [at[0] - 6.5 * scale, at[1] - 2 * scale], scale, tilt: tilt - 62 });
  const R = transformer({ at: [at[0] + 6.5 * scale, at[1] - 2 * scale], scale, tilt: tilt + 62 });
  const K = transformer({ at, scale, tilt });
  const paint = { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.9 };
  return [
    ...K.shapes([
      path('M-1.5 1C-3 6 -4.5 9 -6 12L-2.6 11.2L-1 13.4C0 9.4 0.6 5.6 1 1Z', paint),
      path('M1.5 1C3.4 5.4 5.2 8.2 7 10.6L3.6 10.4L2.4 12.8C1.4 9 0.8 5.4 -0.4 1Z', paint),
    ]),
    L.shape(path(loop, paint)),
    L.shape(dot(2.4, -3.4)),
    R.shape(path(loop, paint)),
    R.shape(dot(2.4, -3.4)),
    ...K.shapes([ellipse(0, 0, 3, 2.8, { fill: 'ribbonDeep', stroke: 'ribbonLine', strokeWidth: 0.8 })]),
  ];
}

/** A classic ribbon bow: two loops, a knot and two tails. */
export function bow({ at, scale = 1, tilt = 0, tails = 7 }) {
  const T = transformer({ at, scale, tilt });
  const paint = { fill: 'ribbon', stroke: 'ribbonLine', strokeWidth: 0.8 };
  return T.shapes([
    path(`M-1.2 1C-2.6 ${3 + tails * 0.5} -3.8 ${4 + tails * 0.8} -5 ${3 + tails}L-2 ${2.4 + tails}L-0.6 ${4 + tails}C0 ${3 + tails * 0.6} 0.4 ${2 + tails * 0.3} 0.6 1Z`, paint),
    path(`M1.2 1C2.6 ${3 + tails * 0.5} 3.8 ${4 + tails * 0.8} 5 ${3 + tails}L2 ${2.4 + tails}L0.6 ${4 + tails}C0 ${3 + tails * 0.6} -0.4 ${2 + tails * 0.3} -0.6 1Z`, paint),
    path('M-1.4 -0.4C-4 -4.6 -9 -5 -9.4 -1.4C-9.8 2.4 -5 3.4 -1.4 0.8Z', paint),
    path('M1.4 -0.4C4 -4.6 9 -5 9.4 -1.4C9.8 2.4 5 3.4 1.4 0.8Z', paint),
    path('M-3.4 -1.2C-5.4 -2.4 -7.2 -2.2 -7.8 -0.8', { stroke: 'ribbonDeep', strokeWidth: 0.7, opacity: 0.7 }),
    path('M3.4 -1.2C5.4 -2.4 7.2 -2.2 7.8 -0.8', { stroke: 'ribbonDeep', strokeWidth: 0.7, opacity: 0.7 }),
    ellipse(0, 0.2, 2, 2.2, { fill: 'ribbonDeep', stroke: 'ribbonLine', strokeWidth: 0.7 }),
  ]);
}

/** Rounded five-point star around (0, 0) with outer radius r. */
export function starPath(r = 6, inner = 0.48) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * inner : r;
    pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  return `M${pts.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`;
}

/** Rotates and scales already-placed shapes around a center point. */
export function around(center, { scale = 1, tilt = 0 }, shapes) {
  const T = transformer({ at: center, scale, tilt });
  return shapes.map((s) => {
    if (s.type === 'path') return T.shape({ ...s, d: mapPath(s.d, (x, y) => [x - center[0], y - center[1]]) });
    return T.shape({ ...s, cx: s.cx - center[0], cy: s.cy - center[1] });
  });
}

// ---------------------------------------------------------------------------
// Arms
//
// Arms are never bent at runtime. Each arm has a few drawn poses (an arm
// "slot"), and the arm bone only rotates the whole drawing. The shoulder is
// a circle centred on the bone pivot, so rotation never opens a gap, and an
// arm is one silhouette: every piece is first drawn with a doubled stroke,
// then filled again on top, which merges the outline.
//
// Angles are degrees from straight down; positive swings the viewer's-left
// arm outward and then up. The right arm is the mirror image.

const rad = (a) => (a * Math.PI) / 180;
const along = (p, a, len) => [p[0] - Math.sin(rad(a)) * len, p[1] + Math.cos(rad(a)) * len];
const across = (p, a, len) => [p[0] + Math.cos(rad(a)) * len, p[1] + Math.sin(rad(a)) * len];
const pt = (p) => `${round(p[0])} ${round(p[1])}`;
const segment = (p, q, a, r1, r2) => `M${pt(across(p, a, r1))}L${pt(across(q, a, r2))}L${pt(across(q, a, -r2))}L${pt(across(p, a, -r1))}Z`;

/** Upper-arm and forearm angles for each drawn arm pose. */
export const ARM_POSES = {
  rest: [4, 10], // hanging, a soft outward curve
  bent: [6, -56], // forearm across the front: holding something
  up: [118, 158], // raised out to the side, hand clear of the face: waving, flailing
  fold: [77, -106], // forearms folded flat: lying on an edge
};
const FRONT_POSES = new Set(['up', 'fold']);

/**
 * Sleeved arms with mitten hands for every pose in {@link ARM_POSES}.
 * @param {object} o
 * @param {[number, number]} o.shoulder left shoulder, the armL bone pivot
 * @param {[number, number, number]} [o.radius] sleeve half-width at shoulder, elbow, cuff
 * @param {number} [o.z] draw order for arms in front of the body
 * @param {number} [o.front] draw order for raised or folded arms (over side hair)
 */
export function arms(o) {
  const {
    shoulder, upper = 22, fore = 20, radius = [9.5, 8.6, 10], z = 24, front = 49,
    sleeve, shade, line, lineWidth = 1.1, cuff, cuffWidth = 1.3, cuffBands = 1,
    skin = 'skin', skinLine = 'skinLine', light = '#ffffff',
  } = o;
  const [rS, rE, rW] = radius;
  const out = [];
  for (const [name, [a1, a2]] of Object.entries(ARM_POSES)) {
    const S = shoulder;
    const E = along(S, a1, upper);
    const W = along(E, a2, fore);
    const H = along(W, a2, 3.4);
    const pieces = [
      ellipse(round(S[0]), round(S[1]), rS, rS),
      ellipse(round(E[0]), round(E[1]), rE, rE),
      path(segment(S, E, a1, rS * 0.97, rE)),
      path(segment(E, W, a2, rE, rW)),
    ];
    const band = (back) => {
      const B = along(W, a2, -back);
      return path(`M${pt(across(B, a2, rW * 0.96))}Q${pt(along(B, a2, 1.8))} ${pt(across(B, a2, -rW * 0.96))}`, { stroke: cuff, strokeWidth: cuffWidth });
    };
    const shapes = [
      ellipse(round(H[0]), round(H[1]), 4.2, 4.6, { fill: skin, stroke: skinLine, strokeWidth: 0.8, rotate: a2 }),
      ...pieces.map((s) => ({ ...s, fill: sleeve, stroke: line, strokeWidth: lineWidth * 2 })),
      ...pieces.map((s) => ({ ...s, fill: sleeve })),
      // Shade on the side that faces the body when hanging, light on the other.
      path(`M${pt(across(along(S, a1, 3), a1, rS * 0.5))}L${pt(across(E, a1, rE * 0.5))}`, { stroke: shade, strokeWidth: rE * 0.55 }),
      path(`M${pt(across(E, a2, rE * 0.5))}L${pt(across(along(W, a2, -2.5), a2, rW * 0.5))}`, { stroke: shade, strokeWidth: rE * 0.55 }),
      path(`M${pt(across(along(S, a1, 4), a1, -rS * 0.55))}L${pt(across(along(E, a1, -2), a1, -rE * 0.55))}`, { stroke: light, strokeWidth: 1.2, opacity: 0.45 }),
      ...Array.from({ length: cuffBands }, (_, i) => band(2.2 + i * 2.6)),
    ];
    const depth = FRONT_POSES.has(name) ? front : z;
    const key = name[0].toUpperCase() + name.slice(1);
    out.push(part(`arm${key}L`, 'armL', depth, shapes, { slot: `armL:${name}` }));
    out.push(part(`arm${key}R`, 'armR', depth, shapes.map((s) => mirrorShape(s)), { slot: `armR:${name}` }));
  }
  return out;
}

/** Bubble gum for the `gum` idle: a small bubble, then a big one. */
export function gum({ at, scale = 1 }) {
  const T = transformer({ at, scale });
  const lips = ellipse(0, 0.4, 1.8, 1.4, { fill: 'mouth', stroke: 'mouthLine', strokeWidth: 0.7 });
  const bubble = (r, dy) => [
    ellipse(0, dy, r, r * 0.94, { fill: 'gum', stroke: 'gumLine', strokeWidth: 0.8 }),
    ellipse(-r * 0.38, dy - r * 0.4, r * 0.3, r * 0.2, { fill: '#ffffff', opacity: 0.85, rotate: -30 }),
    ellipse(r * 0.42, dy + r * 0.38, r * 0.12, r * 0.12, { fill: '#ffffff', opacity: 0.6 }),
  ];
  return [
    part('mouthGum', 'head', 46, T.shapes([lips, ...bubble(4.4, 3.2)]), { slot: 'mouth:gum' }),
    part('mouthGumBig', 'head', 46, T.shapes([lips, ...bubble(11, 7.4)]), { slot: 'mouth:gumBig' }),
  ];
}
