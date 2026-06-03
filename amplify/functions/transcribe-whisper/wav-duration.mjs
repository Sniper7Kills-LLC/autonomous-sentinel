/**
 * Exact duration of a 16 kHz mono signed-16 PCM WAV from its byte length
 * (#671). The transcode stage already produces this canonical WAV for
 * whisper.cpp, so VAD can derive `totalDurationMs` from it with zero extra
 * ffprobe/ffmpeg passes.
 *
 * A canonical WAV is a 44-byte header followed by interleaved sample data.
 * For mono s16le @ 16 kHz: each sample = 2 bytes, so
 *   durationMs = (bytes - 44) / (16000 * 2) * 1000.
 *
 * `parseWavHeader` reads the actual `byte_rate` from the header when
 * present (robust if a future encode changes rate/channels); `pcmDurationMs`
 * is the cheap fixed-format fallback used directly on the known 16 kHz WAV.
 */

export const WHISPER_SAMPLE_RATE_HZ = 16000;
export const WHISPER_BYTES_PER_SAMPLE = 2; // s16le
export const WHISPER_CHANNELS = 1;
export const WAV_HEADER_BYTES = 44;

/**
 * Cheap fixed-format duration for the canonical 16 kHz mono s16le WAV.
 * Clamps a sub-header byte count to 0 ms rather than returning negative.
 */
export function pcmDurationMs(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= WAV_HEADER_BYTES) return 0;
  const dataBytes = byteLength - WAV_HEADER_BYTES;
  const bytesPerSecond = WHISPER_SAMPLE_RATE_HZ * WHISPER_BYTES_PER_SAMPLE * WHISPER_CHANNELS;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

/**
 * Reads `sampleRate` / `channels` / `bitsPerSample` / `dataBytes` from a
 * canonical RIFF/WAVE header `Buffer`. Returns `null` when the buffer is
 * too short or not a PCM WAVE — callers fall back to `pcmDurationMs`.
 */
export function parseWavHeader(buf) {
  if (!buf || buf.length < WAV_HEADER_BYTES) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  // Walk chunks from offset 12 to find `fmt ` + `data`.
  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) return null;
  return { ...fmt, dataBytes };
}

/**
 * Best-effort exact duration from a WAV header buffer + total file size.
 * Uses the parsed `byte_rate` when the header is readable; otherwise the
 * fixed 16 kHz mono assumption. `totalByteLength` is the on-disk size.
 */
export function wavDurationMs(headerBuf, totalByteLength) {
  const header = parseWavHeader(headerBuf);
  if (header && header.sampleRate > 0 && header.channels > 0 && header.bitsPerSample > 0) {
    const bytesPerSecond = header.sampleRate * header.channels * (header.bitsPerSample / 8);
    const dataBytes =
      header.dataBytes && header.dataBytes > 0
        ? header.dataBytes
        : Math.max(0, totalByteLength - WAV_HEADER_BYTES);
    if (bytesPerSecond > 0) return Math.round((dataBytes / bytesPerSecond) * 1000);
  }
  return pcmDurationMs(totalByteLength);
}
