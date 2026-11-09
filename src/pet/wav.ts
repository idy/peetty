export const MAX_AUDIO_SECONDS = 5;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_PCM_BYTES = 8 * 1024 * 1024;

export class InvalidAudio extends Error {}

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function chunk(view: DataView, offset: number, limit: number) {
  if (offset + 8 > limit) throw new InvalidAudio('Truncated WAV chunk');
  const size = view.getUint32(offset + 4, true);
  const start = offset + 8;
  const end = start + size;
  const next = end + (size % 2);
  if (next > limit) throw new InvalidAudio('Truncated WAV chunk');
  return { id: tag(view, offset), size, start, next };
}

function writeTag(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

/** Validate allocation bounds and return a metadata-free integer PCM WAV. */
export function preflightWav(bytes: ArrayBuffer, destinationRate: number): ArrayBuffer {
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_AUDIO_BYTES) throw new InvalidAudio('Invalid WAV size');
  const view = new DataView(bytes);
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new InvalidAudio('Invalid WAV container');
  }
  let format: { channels: number; sampleRate: number; blockAlign: number; bits: number } | undefined;
  let data: { start: number; size: number } | undefined;
  let offset = 12;
  while (offset < bytes.byteLength) {
    const current = chunk(view, offset, bytes.byteLength);
    const { id, size, start } = current;
    if (id === 'fmt ') {
      // A PCM WAVEFORMATEX may add only the zero-length extension field.
      if (format || data || (size !== 16 && size !== 18)) throw new InvalidAudio('Ambiguous WAV format');
      const code = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true);
      const blockAlign = view.getUint16(start + 12, true);
      const bits = view.getUint16(start + 14, true);
      if (code !== 1 || (size === 18 && view.getUint16(start + 16, true) !== 0)) throw new InvalidAudio('Unsupported WAV format');
      if ((channels !== 1 && channels !== 2) || sampleRate < 8_000 || sampleRate > 192_000
        || ![8, 16, 24, 32].includes(bits) || blockAlign !== channels * (bits / 8) || byteRate !== sampleRate * blockAlign) {
        throw new InvalidAudio('Invalid WAV PCM layout');
      }
      format = { channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      if (!format || data || !size || size % format.blockAlign !== 0) throw new InvalidAudio('Invalid WAV data');
      data = { start, size };
    } else if (['RIFF', 'RIFX', 'RF64', 'WAVE', 'ds64', 'slnt'].includes(id)
      || (id === 'LIST' && size >= 4 && tag(view, start) === 'wavl')) {
      throw new InvalidAudio('Unsupported WAV audio container');
    }
    // Ancillary chunks (including bext, cue, fact, smpl and LIST metadata) are
    // bounded above, then discarded. They never reach a native metadata parser.
    offset = current.next;
  }
  if (!format || !data) throw new InvalidAudio('Missing WAV PCM');
  const frames = data.size / format.blockAlign;
  if (frames > MAX_AUDIO_SECONDS * format.sampleRate) throw new InvalidAudio('Audio too long');
  const decodedFrames = Math.ceil(frames * destinationRate / format.sampleRate);
  if (!Number.isFinite(destinationRate) || destinationRate <= 0 || !Number.isSafeInteger(decodedFrames) || decodedFrames <= 0
    || decodedFrames * format.channels * 4 > MAX_PCM_BYTES) {
    throw new InvalidAudio('Decoded audio too large');
  }

  // Canonicalization also removes untrusted duration hints, loop counts, and
  // timestamp metadata without rejecting ordinary audio-editor exports.
  const clean = new ArrayBuffer(44 + data.size + (data.size % 2));
  const output = new DataView(clean);
  writeTag(output, 0, 'RIFF'); output.setUint32(4, clean.byteLength - 8, true);
  writeTag(output, 8, 'WAVE'); writeTag(output, 12, 'fmt '); output.setUint32(16, 16, true);
  output.setUint16(20, 1, true); output.setUint16(22, format.channels, true);
  output.setUint32(24, format.sampleRate, true); output.setUint32(28, format.sampleRate * format.blockAlign, true);
  output.setUint16(32, format.blockAlign, true); output.setUint16(34, format.bits, true);
  writeTag(output, 36, 'data'); output.setUint32(40, data.size, true);
  new Uint8Array(clean, 44, data.size).set(new Uint8Array(bytes, data.start, data.size));
  return clean;
}
