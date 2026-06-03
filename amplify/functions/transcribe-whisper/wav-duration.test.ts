import { describe, it, expect } from 'vitest';
import { pcmDurationMs, parseWavHeader, wavDurationMs, WAV_HEADER_BYTES } from './wav-duration.mjs';

/**
 * Builds a canonical 44-byte RIFF/WAVE header for PCM s16le.
 * `dataBytes` is written into the data chunk size field.
 */
function makeWavHeader(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  dataBytes: number,
) {
  const buf = Buffer.alloc(WAV_HEADER_BYTES);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28); // byte rate
  buf.writeUInt16LE((channels * bitsPerSample) / 8, 32); // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

describe('pcmDurationMs', () => {
  it('computes 1000 ms for one second of 16 kHz mono s16le', () => {
    // 16000 samples * 2 bytes = 32000 data bytes + 44 header
    expect(pcmDurationMs(32000 + WAV_HEADER_BYTES)).toBe(1000);
  });

  it('clamps a sub-header byte count to 0', () => {
    expect(pcmDurationMs(10)).toBe(0);
    expect(pcmDurationMs(WAV_HEADER_BYTES)).toBe(0);
  });

  it('handles non-finite input', () => {
    expect(pcmDurationMs(Number.NaN)).toBe(0);
  });
});

describe('parseWavHeader', () => {
  it('reads sampleRate / channels / bitsPerSample / dataBytes', () => {
    const header = makeWavHeader(16000, 1, 16, 32000);
    expect(parseWavHeader(header)).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 32000,
    });
  });

  it('returns null on a non-RIFF buffer', () => {
    expect(parseWavHeader(Buffer.from('not a wav at all here............'))).toBeNull();
  });

  it('returns null on a too-short buffer', () => {
    expect(parseWavHeader(Buffer.alloc(10))).toBeNull();
  });
});

describe('wavDurationMs', () => {
  it('uses the header byte rate when present (2 s of 16 kHz mono)', () => {
    const header = makeWavHeader(16000, 1, 16, 64000);
    expect(wavDurationMs(header, 64000 + WAV_HEADER_BYTES)).toBe(2000);
  });

  it('honours a non-16 kHz header (8 kHz stereo, 0.5 s)', () => {
    // 8000 * 2ch * 2bytes = 32000 byte/s; 16000 data bytes = 0.5 s
    const header = makeWavHeader(8000, 2, 16, 16000);
    expect(wavDurationMs(header, 16000 + WAV_HEADER_BYTES)).toBe(500);
  });

  it('falls back to the fixed 16 kHz assumption when the header is unreadable', () => {
    expect(wavDurationMs(null, 32000 + WAV_HEADER_BYTES)).toBe(1000);
  });
});
