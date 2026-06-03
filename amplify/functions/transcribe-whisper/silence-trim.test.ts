import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildFilterChain,
  buildArgs,
  readSilenceConfig,
  silenceTrim,
  SilenceTrimError,
  DEFAULT_SILENCE_THRESHOLD_DB,
  DEFAULT_SILENCE_MIN_SEC,
} from './silence-trim.mjs';

/**
 * Behaviour tests for the in-container silence-trim helper (#671).
 * Drives `silenceTrim` through a stubbed spawn so vitest never shells
 * out to a real ffmpeg.
 */

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  return proc;
}

describe('buildFilterChain', () => {
  it('encodes the symmetric silenceremove + areverse chain', () => {
    expect(buildFilterChain(-50, 1)).toBe(
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=1,areverse,' +
        'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=1,areverse',
    );
  });
});

describe('buildArgs', () => {
  it('passes -y -loglevel error and the filter', () => {
    expect(buildArgs('/tmp/in.wav', '/tmp/out.wav', 'F')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/tmp/in.wav',
      '-af',
      'F',
      '/tmp/out.wav',
    ]);
  });
});

describe('readSilenceConfig', () => {
  it('returns defaults on empty env', () => {
    expect(readSilenceConfig({})).toEqual({
      thresholdDb: DEFAULT_SILENCE_THRESHOLD_DB,
      minSilenceSec: DEFAULT_SILENCE_MIN_SEC,
    });
  });

  it('parses valid overrides', () => {
    expect(readSilenceConfig({ SILENCE_THRESHOLD_DB: '-40', SILENCE_MIN_SEC: '0.5' })).toEqual({
      thresholdDb: -40,
      minSilenceSec: 0.5,
    });
  });

  it('rejects a positive threshold (would gate silence everywhere) and a sub-min window', () => {
    expect(readSilenceConfig({ SILENCE_THRESHOLD_DB: '10', SILENCE_MIN_SEC: '0' })).toEqual({
      thresholdDb: DEFAULT_SILENCE_THRESHOLD_DB,
      minSilenceSec: DEFAULT_SILENCE_MIN_SEC,
    });
  });

  it('ignores non-finite values', () => {
    expect(readSilenceConfig({ SILENCE_THRESHOLD_DB: 'abc' }).thresholdDb).toBe(
      DEFAULT_SILENCE_THRESHOLD_DB,
    );
  });
});

describe('silenceTrim', () => {
  it('rejects when inputPath is missing', async () => {
    await expect(silenceTrim({ outputPath: '/tmp/out.wav' } as never)).rejects.toThrow(
      'inputPath required',
    );
  });

  it('rejects when input and output are the same path', async () => {
    await expect(
      silenceTrim({ inputPath: '/tmp/x.wav', outputPath: '/tmp/x.wav' }),
    ).rejects.toThrow('must differ');
  });

  it('resolves on exit code 0 with the applied params', async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn().mockReturnValue(proc);
    const p = silenceTrim({
      inputPath: '/tmp/in.mp3',
      outputPath: '/tmp/out.wav',
      ffmpegPath: '/usr/local/bin/ffmpeg',
      spawnFn: spawnFn as never,
    });
    proc.emit('close', 0);
    const res = await p;
    expect(res.thresholdDb).toBe(DEFAULT_SILENCE_THRESHOLD_DB);
    expect(res.minSilenceSec).toBe(DEFAULT_SILENCE_MIN_SEC);
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/local/bin/ffmpeg',
      expect.arrayContaining(['-i', '/tmp/in.mp3', '/tmp/out.wav']),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );
  });

  it('rejects with SilenceTrimError carrying the stderr tail on non-zero exit', async () => {
    const proc = makeFakeProc();
    const p = silenceTrim({
      inputPath: '/tmp/in.mp3',
      outputPath: '/tmp/out.wav',
      spawnFn: (() => proc) as never,
    });
    proc.stderr.emit('data', Buffer.from('boom'));
    proc.emit('close', 1);
    await expect(p).rejects.toMatchObject({
      name: 'SilenceTrimError',
      code: 1,
      stderr: 'boom',
    });
    await expect(p).rejects.toBeInstanceOf(SilenceTrimError);
  });
});
