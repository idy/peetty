/** Archive and transfer ceilings, independent of the model's runtime context budget. */
export const PROFILE_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  profiles: 100,
  memories: 1_000,
  entries: 100_000,
  entryText: 1_000_000,
  memoryText: 8_000,
  name: 120,
  personality: 16_000,
  figureReference: 1_000_000,
});
