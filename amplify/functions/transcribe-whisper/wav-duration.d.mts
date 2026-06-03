/**
 * Type declarations for `wav-duration.mjs` (#671). Hand-maintained.
 * Source of truth: `wav-duration.mjs`. Keep in sync.
 */

export const WHISPER_SAMPLE_RATE_HZ: number;
export const WHISPER_BYTES_PER_SAMPLE: number;
export const WHISPER_CHANNELS: number;
export const WAV_HEADER_BYTES: number;

export function pcmDurationMs(byteLength: number): number;

export interface WavHeader {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number | null;
}

export function parseWavHeader(buf: Buffer | null | undefined): WavHeader | null;

export function wavDurationMs(
  headerBuf: Buffer | null | undefined,
  totalByteLength: number,
): number;
