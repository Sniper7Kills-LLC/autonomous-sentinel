import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as SpawnFn } from 'node:child_process';
import {
  DEFAULT_VAD_MIN_SILENCE_SEC,
  DEFAULT_VAD_NOISE_DB,
  VadError,
  buildSegments,
  parseSilenceDetect,
  readVadConfig,
  runVad,
  summarise,
} from './vad';

/**
 * Behaviour tests for the VAD helper (#50).
 *
 * Drives `runVad` through a stubbed spawn so vitest never
 * shells out to a real ffmpeg. Pins the stderr parser, the
 * segment builder, env-config resolution, spawn arg shape,
 * success path, non-zero exit, and the all-silence + all-
 * speech edge cases.
 */

interface FakeProc {
  stderr: EventEmitter;
  emit(event: string, ...args: unknown[]): boolean;
}

function makeFakeProc(): FakeProc {
  const procEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  return Object.assign(procEmitter, { stderr: stderrEmitter });
}

describe('parseSilenceDetect', () => {
  it('parses paired silence_start / silence_end lines', () => {
    const stderr = [
      '[silencedetect @ 0xff] silence_start: 2.000',
      '[silencedetect @ 0xff] silence_end: 5.500 | silence_duration: 3.500',
      '[silencedetect @ 0xff] silence_start: 10.250',
      '[silencedetect @ 0xff] silence_end: 12.750 | silence_duration: 2.500',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 20_000)).toEqual([
      { startMs: 2_000, endMs: 5_500 },
      { startMs: 10_250, endMs: 12_750 },
    ]);
  });

  it('closes an unmatched trailing silence_start at totalDurationMs', () => {
    const stderr = '[silencedetect @ 0xff] silence_start: 8.000';
    expect(parseSilenceDetect(stderr, 12_000)).toEqual([{ startMs: 8_000, endMs: 12_000 }]);
  });

  it('drops an unmatched leading silence_end', () => {
    const stderr = [
      '[silencedetect @ 0xff] silence_end: 1.000 | silence_duration: 1.000',
      '[silencedetect @ 0xff] silence_start: 5.000',
      '[silencedetect @ 0xff] silence_end: 6.000 | silence_duration: 1.000',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 10_000)).toEqual([{ startMs: 5_000, endMs: 6_000 }]);
  });

  it('handles two silence_start in a row by closing the first at the second', () => {
    const stderr = [
      '[silencedetect @ 0xff] silence_start: 1.000',
      '[silencedetect @ 0xff] silence_start: 3.000',
      '[silencedetect @ 0xff] silence_end: 4.000 | silence_duration: 1.000',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 10_000)).toEqual([
      { startMs: 1_000, endMs: 3_000 },
      { startMs: 3_000, endMs: 4_000 },
    ]);
  });

  it('returns [] when stderr contains no silencedetect lines', () => {
    expect(parseSilenceDetect('frame=    1 fps=0.0 q=-0.0 size=N/A time=N/A\n', 10_000)).toEqual(
      [],
    );
  });

  it('clamps negative silence_start to 0 (defensive)', () => {
    const stderr = [
      '[silencedetect @ 0xff] silence_start: -0.5',
      '[silencedetect @ 0xff] silence_end: 1.0 | silence_duration: 1.5',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 5_000)).toEqual([{ startMs: 0, endMs: 1_000 }]);
  });
});

describe('buildSegments', () => {
  it('alternates speech + silence intervals covering the full duration', () => {
    const segs = buildSegments(
      [
        { startMs: 2_000, endMs: 5_000 },
        { startMs: 8_000, endMs: 9_000 },
      ],
      12_000,
    );
    expect(segs).toEqual([
      { startMs: 0, endMs: 2_000, isSpeech: true },
      { startMs: 2_000, endMs: 5_000, isSpeech: false },
      { startMs: 5_000, endMs: 8_000, isSpeech: true },
      { startMs: 8_000, endMs: 9_000, isSpeech: false },
      { startMs: 9_000, endMs: 12_000, isSpeech: true },
    ]);
  });

  it('returns a single speech segment when no silence intervals', () => {
    expect(buildSegments([], 10_000)).toEqual([{ startMs: 0, endMs: 10_000, isSpeech: true }]);
  });

  it('returns a single silence segment when silence spans the whole recording', () => {
    expect(buildSegments([{ startMs: 0, endMs: 10_000 }], 10_000)).toEqual([
      { startMs: 0, endMs: 10_000, isSpeech: false },
    ]);
  });

  it('clamps silence beyond totalDurationMs', () => {
    const segs = buildSegments([{ startMs: 8_000, endMs: 15_000 }], 10_000);
    expect(segs).toEqual([
      { startMs: 0, endMs: 8_000, isSpeech: true },
      { startMs: 8_000, endMs: 10_000, isSpeech: false },
    ]);
  });

  it('drops invalid / reversed silence intervals', () => {
    const segs = buildSegments(
      [
        { startMs: 5_000, endMs: 3_000 }, // reversed
        { startMs: Number.NaN, endMs: 1_000 }, // NaN
        { startMs: 2_000, endMs: 4_000 }, // valid
      ],
      10_000,
    );
    expect(segs).toEqual([
      { startMs: 0, endMs: 2_000, isSpeech: true },
      { startMs: 2_000, endMs: 4_000, isSpeech: false },
      { startMs: 4_000, endMs: 10_000, isSpeech: true },
    ]);
  });

  it('merges overlapping silence intervals (defensive against malformed ffmpeg stream)', () => {
    const segs = buildSegments(
      [
        { startMs: 2_000, endMs: 5_000 },
        { startMs: 3_000, endMs: 6_000 }, // overlaps the previous
        { startMs: 8_000, endMs: 9_000 },
      ],
      12_000,
    );
    expect(segs).toEqual([
      { startMs: 0, endMs: 2_000, isSpeech: true },
      { startMs: 2_000, endMs: 6_000, isSpeech: false }, // merged
      { startMs: 6_000, endMs: 8_000, isSpeech: true },
      { startMs: 8_000, endMs: 9_000, isSpeech: false },
      { startMs: 9_000, endMs: 12_000, isSpeech: true },
    ]);
  });

  it('merges adjacent (touching) silence intervals into one', () => {
    const segs = buildSegments(
      [
        { startMs: 2_000, endMs: 4_000 },
        { startMs: 4_000, endMs: 6_000 }, // touches the previous
      ],
      10_000,
    );
    expect(segs).toEqual([
      { startMs: 0, endMs: 2_000, isSpeech: true },
      { startMs: 2_000, endMs: 6_000, isSpeech: false },
      { startMs: 6_000, endMs: 10_000, isSpeech: true },
    ]);
  });

  it('sorts unsorted silence intervals before building', () => {
    const segs = buildSegments(
      [
        { startMs: 8_000, endMs: 9_000 },
        { startMs: 2_000, endMs: 5_000 },
      ],
      12_000,
    );
    expect(segs[0]).toEqual({ startMs: 0, endMs: 2_000, isSpeech: true });
    expect(segs[1]).toEqual({ startMs: 2_000, endMs: 5_000, isSpeech: false });
  });
});

describe('summarise', () => {
  it('sums speech + silence ms separately', () => {
    expect(
      summarise([
        { startMs: 0, endMs: 2_000, isSpeech: true },
        { startMs: 2_000, endMs: 5_000, isSpeech: false },
        { startMs: 5_000, endMs: 10_000, isSpeech: true },
      ]),
    ).toEqual({ speechMs: 7_000, silenceMs: 3_000 });
  });

  it('returns zeros for empty input', () => {
    expect(summarise([])).toEqual({ speechMs: 0, silenceMs: 0 });
  });
});

describe('readVadConfig', () => {
  it('returns built-in defaults when env is unset', () => {
    expect(readVadConfig({})).toEqual({
      noiseDb: DEFAULT_VAD_NOISE_DB,
      minSilenceSec: DEFAULT_VAD_MIN_SILENCE_SEC,
    });
  });

  it('honours valid env overrides', () => {
    expect(readVadConfig({ VAD_NOISE_DB: '-40', VAD_MIN_SILENCE_SEC: '1.0' })).toEqual({
      noiseDb: -40,
      minSilenceSec: 1.0,
    });
  });

  it('rejects noise above 0 dB + min-silence below 0.01 sec', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readVadConfig({ VAD_NOISE_DB: '5', VAD_MIN_SILENCE_SEC: '0' })).toEqual({
      noiseDb: DEFAULT_VAD_NOISE_DB,
      minSilenceSec: DEFAULT_VAD_MIN_SILENCE_SEC,
    });
    warn.mockRestore();
  });
});

describe('runVad — input validation', () => {
  it('rejects on missing inputPath', async () => {
    await expect(runVad({ inputPath: '', totalDurationMs: 10_000 })).rejects.toThrow(/inputPath/);
  });

  it('rejects on non-positive totalDurationMs', async () => {
    await expect(runVad({ inputPath: '/in', totalDurationMs: 0 })).rejects.toThrow(
      /totalDurationMs/,
    );
    await expect(runVad({ inputPath: '/in', totalDurationMs: -1 })).rejects.toThrow(
      /totalDurationMs/,
    );
  });
});

describe('runVad — spawn arg shape', () => {
  it('invokes ffmpeg with silencedetect filter + -f null discard', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await runVad({
      inputPath: '/in.wav',
      totalDurationMs: 10_000,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(recordedArgs).toContain('-nostats');
    expect(recordedArgs).toContain('-i');
    expect(recordedArgs).toContain('/in.wav');
    expect(recordedArgs).toContain('-af');
    const filterArg = recordedArgs[recordedArgs.indexOf('-af') + 1];
    expect(filterArg).toBe(
      `silencedetect=noise=${DEFAULT_VAD_NOISE_DB}dB:d=${DEFAULT_VAD_MIN_SILENCE_SEC}`,
    );
    // `-f null -` discards output via the null muxer
    expect(recordedArgs[recordedArgs.length - 3]).toBe('-f');
    expect(recordedArgs[recordedArgs.length - 2]).toBe('null');
    expect(recordedArgs[recordedArgs.length - 1]).toBe('-');
  });

  it('threads custom noise + min-silence into the filter', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await runVad({
      inputPath: '/in.wav',
      totalDurationMs: 10_000,
      noiseDb: -30,
      minSilenceSec: 1.0,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    const filterArg = recordedArgs[recordedArgs.indexOf('-af') + 1];
    expect(filterArg).toBe('silencedetect=noise=-30dB:d=1');
  });
});

describe('runVad — success', () => {
  it('returns the parsed segments + speechMs + silenceMs', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit(
          'data',
          Buffer.from(
            [
              '[silencedetect @ 0xff] silence_start: 2.000',
              '[silencedetect @ 0xff] silence_end: 5.000 | silence_duration: 3.000',
            ].join('\n'),
          ),
        );
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await runVad({
      inputPath: '/in.wav',
      totalDurationMs: 10_000,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 2_000, isSpeech: true },
      { startMs: 2_000, endMs: 5_000, isSpeech: false },
      { startMs: 5_000, endMs: 10_000, isSpeech: true },
    ]);
    expect(result.speechMs).toBe(7_000);
    expect(result.silenceMs).toBe(3_000);
  });

  it('all-speech: no silencedetect lines → single speech segment', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('size=N/A time=N/A\n'));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await runVad({
      inputPath: '/in.wav',
      totalDurationMs: 5_000,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.segments).toEqual([{ startMs: 0, endMs: 5_000, isSpeech: true }]);
    expect(result.speechMs).toBe(5_000);
    expect(result.silenceMs).toBe(0);
  });

  it('all-silence: one silencedetect interval covering the full duration', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit(
          'data',
          Buffer.from(
            [
              '[silencedetect @ 0xff] silence_start: 0.000',
              '[silencedetect @ 0xff] silence_end: 5.000 | silence_duration: 5.000',
            ].join('\n'),
          ),
        );
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await runVad({
      inputPath: '/in.wav',
      totalDurationMs: 5_000,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.segments).toEqual([{ startMs: 0, endMs: 5_000, isSpeech: false }]);
    expect(result.speechMs).toBe(0);
    expect(result.silenceMs).toBe(5_000);
  });
});

describe('runVad — failure modes', () => {
  it('rejects with VadError on non-zero exit, carrying stderr tail', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('Invalid input format\n'));
        fakeProc.emit('close', 1);
      });
      return fakeProc;
    });
    try {
      await runVad({
        inputPath: '/in.wav',
        totalDurationMs: 10_000,
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(VadError);
      expect((err as VadError).code).toBe(1);
      expect((err as VadError).stderr).toContain('Invalid input format');
    }
  });

  it('rejects with VadError on spawn-thrown error', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT: ffmpeg not found');
    }) as unknown as typeof SpawnFn;
    await expect(
      runVad({ inputPath: '/in.wav', totalDurationMs: 10_000, spawnFn }),
    ).rejects.toBeInstanceOf(VadError);
  });
});
