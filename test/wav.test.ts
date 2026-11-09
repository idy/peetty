import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidAudio, MAX_AUDIO_BYTES, MAX_PCM_BYTES, preflightWav } from '../src/pet/wav.ts';

function chunk(id: string, data: Uint8Array, padded = true): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + data.length + (padded ? data.length % 2 : 0));
  bytes.set(new TextEncoder().encode(id), 0);
  new DataView(bytes.buffer).setUint32(4, data.length, true);
  bytes.set(data, 8);
  return bytes;
}
function riff(...chunks: Uint8Array[]): ArrayBuffer {
  const bytes = new Uint8Array(12 + chunks.reduce((sum, part) => sum + part.length, 0));
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode('WAVE'), 8);
  let offset = 12;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return bytes.buffer;
}
interface Format {
  code?: number;
  channels?: number;
  sampleRate?: number;
  bits?: number;
  blockAlign?: number;
  byteRate?: number;
  extended?: boolean;
  extensionSize?: number;
}
function fmt({ code = 1, channels = 1, sampleRate = 8_000, bits = 16, blockAlign = channels * bits / 8,
  byteRate = sampleRate * blockAlign, extended = false, extensionSize = 0 }: Format = {}): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(extended ? 18 : 16);
  const view = new DataView(data.buffer);
  view.setUint16(0, code, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, byteRate, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bits, true);
  if (extended) view.setUint16(16, extensionSize, true);
  return chunk('fmt ', data);
}
function wav({ frames = 1, channels = 1, sampleRate = 8_000, bits = 16 } = {}): ArrayBuffer {
  return riff(fmt({ channels, sampleRate, bits }), chunk('data', new Uint8Array(frames * channels * bits / 8)));
}
function set32(bytes: ArrayBuffer, offset: number, value: number): ArrayBuffer {
  new DataView(bytes).setUint32(offset, value, true);
  return bytes;
}
function rejects(bytes: ArrayBuffer, rate = 48_000): void { assert.throws(() => preflightWav(bytes, rate), InvalidAudio); }

describe('bounded integer PCM WAV preflight', () => {
  for (const channels of [1, 2]) {
    for (const bits of [8, 16, 24, 32]) {
      it(`accepts ordinary ${channels}-channel ${bits}-bit PCM, including an odd data pad`, () => {
        assert.doesNotThrow(() => preflightWav(wav({ channels, bits, frames: 3 }), 48_000));
      });
    }
  }

  it('accepts PCM WAVEFORMATEX only with an empty extension', () => {
    assert.doesNotThrow(() => preflightWav(riff(fmt({ extended: true }), chunk('data', new Uint8Array(2))), 48_000));
    rejects(riff(fmt({ extended: true, extensionSize: 1 }), chunk('data', new Uint8Array(2))));
  });

  it('accepts bounded JUNK and INFO metadata before or after audio', () => {
    const metadata = chunk('LIST', new Uint8Array([
      ...new TextEncoder().encode('INFO'),
      ...chunk('INAM', new TextEncoder().encode('A tiny cue\0')),
      ...chunk('ISFT', new TextEncoder().encode('Peetty\0')),
    ]));
    assert.doesNotThrow(() => preflightWav(riff(
      chunk('JUNK', new Uint8Array(3)), metadata, fmt(), chunk('data', new Uint8Array(2)), metadata, chunk('JUNK', new Uint8Array(0)),
    ), 48_000));
  });

  it('accepts the five-second limit at the minimum and maximum source rates', () => {
    for (const sampleRate of [8_000, 192_000]) {
      assert.doesNotThrow(() => preflightWav(wav({ frames: sampleRate * 5, channels: 2, sampleRate, bits: 8 }), 48_000));
      rejects(wav({ frames: sampleRate * 5 + 1, sampleRate, bits: 8 }));
    }
  });

  it('bounds decoded Float32 PCM at the destination resampling rate, with conservative frame rounding', () => {
    const bytes = wav({ frames: 32_000, channels: 2, bits: 8 }); // Four seconds at 8 kHz.
    assert.doesNotThrow(() => preflightWav(bytes, 262_144)); // Exactly 8 MiB at this destination rate.
    rejects(bytes, 262_145);
    const oneFrame = wav({ channels: 2 });
    assert.doesNotThrow(() => preflightWav(oneFrame, MAX_PCM_BYTES / 8 * 8_000));
    rejects(oneFrame, MAX_PCM_BYTES / 8 * 8_000 + 1); // Fractional output frames must round up.
  });

  it('rejects invalid or unbounded destination rates', () => {
    for (const rate of [0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE]) rejects(wav(), rate);
  });

  it('rejects empty, truncated, and oversized actual input buffers', () => {
    for (let length = 0; length < 12; length++) rejects(new ArrayBuffer(length));
    rejects(new ArrayBuffer(MAX_AUDIO_BYTES + 1));
    rejects(wav({ frames: MAX_AUDIO_BYTES / 8, channels: 2, bits: 32, sampleRate: 192_000 }));
  });

  it('rejects MP3, Ogg, and FLAC signatures before they can reach native decoding', () => {
    for (const signature of ['ID3', '\xff\xfb', 'OggS', 'fLaC']) {
      const bytes = new Uint8Array(128);
      bytes.set(Uint8Array.from(signature, (char) => char.charCodeAt(0)));
      rejects(bytes.buffer);
    }
  });

  it('rejects RF64, RIFX, unrelated RIFF types, and unsupported format codes', () => {
    for (const id of ['RF64', 'RIFX', 'riff', 'JUNK']) {
      const bytes = wav(); new Uint8Array(bytes, 0, 4).set(new TextEncoder().encode(id)); rejects(bytes);
    }
    const notWave = wav(); new Uint8Array(notWave, 8, 4).set(new TextEncoder().encode('AVI ')); rejects(notWave);
    // IEEE float is intentionally outside this integer-PCM first release.
    for (const code of [0, 2, 3, 6, 7, 0x11, 0x55, 0xfffe, 0xffff]) {
      rejects(riff(fmt({ code }), chunk('data', new Uint8Array(2))));
    }
    const extensible = new Uint8Array(40);
    new DataView(extensible.buffer).setUint16(0, 0xfffe, true);
    rejects(riff(chunk('fmt ', extensible), chunk('data', new Uint8Array(2))));
  });

  it('rejects container size lies and any bytes outside the declared RIFF', () => {
    for (const size of [0, 4, 36, 39, 0xffff_ffff]) rejects(set32(wav(), 4, size));
    const original = wav();
    const trailingStream = new Uint8Array(original.byteLength + original.byteLength);
    trailingStream.set(new Uint8Array(original)); trailingStream.set(new Uint8Array(original), original.byteLength);
    rejects(trailingStream.buffer);
    rejects(set32(wav(), 4, wav().byteLength - 7));
  });

  it('rejects absent, duplicate, reordered, and empty fmt/data chunks', () => {
    const data = () => chunk('data', new Uint8Array(2));
    for (const bytes of [riff(), riff(fmt()), riff(data()), riff(data(), fmt()), riff(fmt(), fmt(), data()),
      riff(fmt(), data(), fmt()), riff(fmt(), data(), data()), riff(fmt(), chunk('data', new Uint8Array(0)))]) rejects(bytes);
  });

  it('rejects short, oversized, or unexplained format records', () => {
    for (const size of [0, 2, 14, 15, 17, 19, 20, 40, 65_536]) {
      rejects(riff(chunk('fmt ', new Uint8Array(size)), chunk('data', new Uint8Array(2))));
    }
    rejects(set32(wav(), 16, 0xffff_ffff));
  });

  it('rejects claimed chunk payloads beyond the container, including huge data lengths', () => {
    for (const size of [3, 0x7fff_ffff, 0xffff_ffff]) rejects(set32(wav(), 40, size));
    const truncated = wav().slice(0, -1);
    rejects(set32(truncated, 4, truncated.byteLength - 8));
    const fakeSmallContainer = wav({ frames: 40_001 });
    rejects(set32(fakeSmallContainer, 4, 38)); // Native must never discover the unvalidated trailing audio.
  });

  it('rejects incomplete trailing chunk headers and missing or nonzero padding', () => {
    for (let size = 1; size < 8; size++) rejects(riff(fmt(), chunk('data', new Uint8Array(2)), new Uint8Array(size)));
    rejects(riff(fmt({ bits: 8 }), chunk('data', new Uint8Array(1), false)));
    rejects(riff(chunk('JUNK', new Uint8Array(1), false), fmt(), chunk('data', new Uint8Array(2))));
    const padded = wav({ bits: 8 }); new Uint8Array(padded)[padded.byteLength - 1] = 255; rejects(padded);
  });

  it('rejects unknown chunks, nested audio lists, and malformed INFO subchunks', () => {
    for (const id of ['fact', 'ds64', 'smpl', 'RIFF', 'WAVE']) {
      rejects(riff(fmt(), chunk(id, new Uint8Array(4)), chunk('data', new Uint8Array(2))));
    }
    for (const list of [new Uint8Array(3), new TextEncoder().encode('wavl'),
      new Uint8Array([...new TextEncoder().encode('INFO'), ...chunk('data', new Uint8Array(2))]),
      new Uint8Array([...new TextEncoder().encode('INFO'), ...chunk('INAM', new Uint8Array(1), false)]),
      new Uint8Array([...new TextEncoder().encode('INFO'), 0]),
      new Uint8Array([...new TextEncoder().encode('INFO'), ...new Uint8Array(set32(chunk('INAM', new Uint8Array(2)).buffer, 4, 100))])]) {
      rejects(riff(fmt(), chunk('LIST', list), chunk('data', new Uint8Array(2))));
    }
  });

  it('rejects unsupported channel counts, rates, bit depths, and inconsistent byte rates/alignment', () => {
    const invalid: Format[] = [
      ...[0, 3, 8, 0xffff].map((channels) => ({ channels })),
      ...[0, 1, 7_999, 192_001, 0xffff_ffff].map((sampleRate) => ({ sampleRate })),
      ...[0, 1, 4, 12, 20, 64, 0xffff].map((bits) => ({ bits })),
      ...[0, 1, 3, 0xffff].map((blockAlign) => ({ blockAlign })),
      ...[0, 1, 15_999, 16_001, 0xffff_ffff].map((byteRate) => ({ byteRate })),
    ];
    for (const format of invalid) rejects(riff(fmt(format), chunk('data', new Uint8Array(2))));
    rejects(riff(fmt({ channels: 2, bits: 24 }), chunk('data', new Uint8Array(5))));
  });

  it('never relies on a forged byte rate to make overlong PCM look short', () => {
    rejects(riff(fmt({ byteRate: 0xffff_ffff }), chunk('data', new Uint8Array(80_002))));
    rejects(wav({ frames: 40_001 })); // The real data is one frame beyond five seconds.
  });
});
