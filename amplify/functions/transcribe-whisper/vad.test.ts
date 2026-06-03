import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  parseSilenceDetect,
  buildSegments,
  summarise,
  readVadConfig,
  runVad,
  VadError,
  DEFAULT_VAD_NOISE_DB,
  DEFAULT_VAD_MIN_SILENCE_SEC,
} from './vad.mjs';

/**
 * Behaviour tests for the in-container VAD helper (#671) — the producer
 * of the more-to-follow split seam. Stubbed spawn; no real ffmpeg.
 */

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  return proc;
}

describe('parseSilenceDetect', () => {
  it('pairs start/end into ms intervals', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 12.345',
      '[silencedetect @ 0x1] silence_end: 15.678 | silence_duration: 3.333',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 60000)).toEqual([{ startMs: 12345, endMs: 15678 }]);
  });

  it('closes a trailing unmatched silence_start at totalDurationMs', () => {
    const stderr = '[silencedetect @ 0x1] silence_start: 50.0';
    expect(parseSilenceDetect(stderr, 60000)).toEqual([{ startMs: 50000, endMs: 60000 }]);
  });

  it('drops an unmatched leading silence_end', () => {
    const stderr = '[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 2.0';
    expect(parseSilenceDetect(stderr, 60000)).toEqual([]);
  });
});

describe('buildSegments', () => {
  it('inverts one mid silence into speech/silence/speech covering the full span', () => {
    const segments = buildSegments([{ startMs: 12345, endMs: 15678 }], 60000);
    expect(segments).toEqual([
      { startMs: 0, endMs: 12345, isSpeech: true },
      { startMs: 12345, endMs: 15678, isSpeech: false },
      { startMs: 15678, endMs: 60000, isSpeech: true },
    ]);
  });

  it('returns a single speech segment when there is no silence', () => {
    expect(buildSegments([], 60000)).toEqual([{ startMs: 0, endMs: 60000, isSpeech: true }]);
  });

  it('merges overlapping silences so two silences never sit adjacent', () => {
    const segments = buildSegments(
      [
        { startMs: 1000, endMs: 3000 },
        { startMs: 2500, endMs: 4000 },
      ],
      10000,
    );
    expect(segments).toEqual([
      { startMs: 0, endMs: 1000, isSpeech: true },
      { startMs: 1000, endMs: 4000, isSpeech: false },
      { startMs: 4000, endMs: 10000, isSpeech: true },
    ]);
  });

  it('covers [0, total) exactly — segment durations sum to total', () => {
    const segments = buildSegments([{ startMs: 1000, endMs: 2000 }], 5000);
    const total = segments.reduce((acc, s) => acc + (s.endMs - s.startMs), 0);
    expect(total).toBe(5000);
  });
});

describe('summarise', () => {
  it('sums speech vs silence ms', () => {
    const segments = [
      { startMs: 0, endMs: 1000, isSpeech: true },
      { startMs: 1000, endMs: 1500, isSpeech: false },
      { startMs: 1500, endMs: 3000, isSpeech: true },
    ];
    expect(summarise(segments)).toEqual({ speechMs: 2500, silenceMs: 500 });
  });
});

describe('readVadConfig', () => {
  it('defaults', () => {
    expect(readVadConfig({})).toEqual({
      noiseDb: DEFAULT_VAD_NOISE_DB,
      minSilenceSec: DEFAULT_VAD_MIN_SILENCE_SEC,
    });
  });

  it('rejects a positive noise gate', () => {
    expect(readVadConfig({ VAD_NOISE_DB: '5' }).noiseDb).toBe(DEFAULT_VAD_NOISE_DB);
  });
});

describe('runVad', () => {
  it('rejects without a positive totalDurationMs', async () => {
    await expect(runVad({ inputPath: '/tmp/in.wav', totalDurationMs: 0 })).rejects.toThrow(
      'totalDurationMs',
    );
  });

  it('parses stderr into segments on exit 0', async () => {
    const proc = makeFakeProc();
    const p = runVad({
      inputPath: '/tmp/in.wav',
      totalDurationMs: 60000,
      spawnFn: (() => proc) as never,
    });
    proc.stderr.emit(
      'data',
      Buffer.from('[silencedetect] silence_start: 12.0\n[silencedetect] silence_end: 15.0\n'),
    );
    proc.emit('close', 0);
    const res = await p;
    expect(res.segments).toEqual([
      { startMs: 0, endMs: 12000, isSpeech: true },
      { startMs: 12000, endMs: 15000, isSpeech: false },
      { startMs: 15000, endMs: 60000, isSpeech: true },
    ]);
    expect(res.speechMs).toBe(57000);
    expect(res.silenceMs).toBe(3000);
  });

  it('rejects with VadError on non-zero exit', async () => {
    const proc = makeFakeProc();
    const p = runVad({
      inputPath: '/tmp/in.wav',
      totalDurationMs: 1000,
      spawnFn: (() => proc) as never,
    });
    proc.stderr.emit('data', Buffer.from('vad boom'));
    proc.emit('close', 2);
    await expect(p).rejects.toMatchObject({ name: 'VadError', code: 2 });
    await expect(p).rejects.toBeInstanceOf(VadError);
  });
});
