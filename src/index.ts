export { FigureView, type FigureViewOptions } from './figure/view.ts';
export { Motion, type Mood, type Emote, type MotionFrame } from './figure/motion.ts';
export { RigRenderer, type RigOptions } from './figure/rig.ts';
export { validateFigure, FigureError, LIMITS } from './figure/validate.ts';
export * from './figure/types.ts';
export { Peetty, createPeetty, type PeettyOptions, type Activity } from './pet/pet.ts';
export { PRESETS, PRESET_IDS, FIGURE_CATALOG, resolveFigure, listFigures, type PresetId, type CatalogEntry } from './presets.ts';
export { planJump, landing, GRAVITY } from './pet/physics.ts';
