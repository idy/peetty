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
  if (next !== end && view.getUint8(end) !== 0) throw new InvalidAudio('Invalid WAV padding');
  return { id: tag(view, offset), size, start, next };
}

/** Only INFO metadata is harmless here; LIST/wavl can contain additional audio. */
function checkInfo(view: DataView, start: number, size: number): void {
  const end = start + size;
  if (size < 4 || tag(view, start) !== 'INFO') throw new InvalidAudio('Unsupported WAV list');
  let offset = start + 4;
  while (offset < end) {
    const entry = chunk(view, offset, end);
    if (!/^I[A-Z0-9 ]{3}$/.test(entry.id)) throw new InvalidAudio('Unsupported WAV metadata');
    offset = entry.next;
  }
}

/**
 * Prove the PCM allocation is bounded before invoking a native decoder. This
 * deliberately accepts only integer PCM RIFF/WAVE, never compressed, extensible,
 * nested audio, or bytes beyond the validated container.
 */
export function preflightWav(bytes: ArrayBuffer, destinationRate: number): void {
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_AUDIO_BYTES) throw new InvalidAudio('Invalid WAV size');
  const view = new DataView(bytes);
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new InvalidAudio('Invalid WAV container');
  }
  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let dataSize: number | undefined;
  let offset = 12;
  while (offset < bytes.byteLength) {
    const current = chunk(view, offset, bytes.byteLength);
    const { id, size, start } = current;
    if (id === 'fmt ') {
      // A PCM WAVEFORMATEX may add only the zero-length extension field.
      if (format || dataSize !== undefined || (size !== 16 && size !== 18)) throw new InvalidAudio('Ambiguous WAV format');
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
      format = { channels, sampleRate, blockAlign };
    } else if (id === 'data') {
      if (!format || dataSize !== undefined || !size || size % format.blockAlign !== 0) throw new InvalidAudio('Invalid WAV data');
      dataSize = size;
    } else if (id === 'LIST') {
      checkInfo(view, start, size);
    } else if (id !== 'JUNK') {
      // Unknown chunks can change how a decoder interprets the stream.
      throw new InvalidAudio('Unsupported WAV chunk');
    }
    offset = current.next;
  }
  if (!format || dataSize === undefined) throw new InvalidAudio('Missing WAV PCM');
  const frames = dataSize / format.blockAlign;
  if (frames > MAX_AUDIO_SECONDS * format.sampleRate) throw new InvalidAudio('Audio too long');
  // Native decoding resamples to the context rate, not necessarily the file rate.
  const decodedFrames = Math.ceil(frames * destinationRate / format.sampleRate);
  if (!Number.isFinite(destinationRate) || destinationRate <= 0 || !Number.isSafeInteger(decodedFrames) || decodedFrames <= 0
    || decodedFrames * format.channels * 4 > MAX_PCM_BYTES) {
    throw new InvalidAudio('Decoded audio too large');
  }
}
