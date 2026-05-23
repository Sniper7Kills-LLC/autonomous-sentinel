import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as SpawnFn } from 'node:child_process';
import {
  DEFAULT_SILENCE_MIN_SEC,
  DEFAULT_SILENCE_THRESHOLD_DB,
  SilenceTrimError,
  buildFilterChain,
  readSilenceConfig,
  silenceTrim,
} from './silence-trim';

/**
 * Behaviour tests for the silence-trim helper (#49).
 *
 * Drives `silenceTrim` through a stubbed `spawn` so vitest
 * never shells out to a real ffmpeg. Pins the filter chain,
 * env config resolution, spawn arg shape, success path, non-
 * zero exit + spawn-error rejections, and stderr-tail capture.
 */

interface FakeProc {
  stderr: EventEmitter;
  emit(event: string, ...args: unknown[]): boolean;
}

function makeFakeProc(): FakeProc {
  const procEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  // Mimic Node's ChildProcess minimal surface: `stderr` is an
  // event emitter that emits `data` chunks; the child itself
  // emits `error` + `close`. We don't need real streams here —
  // the helper only consumes via `.on('data', ...)`.
  return Object.assign(procEmitter, { stderr: stderrEmitter });
}

describe('buildFilterChain', () => {
  it('produces the symmetric silenceremove + areverse chain', () => {
    const filter = buildFilterChain(-50, 1.0);
    expect(filter).toBe(
      'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=1,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=1,areverse',
    );
  });

  it('honours custom threshold + min-silence values', () => {
    const filter = buildFilterChain(-30, 0.5);
    expect(filter).toContain('start_threshold=-30dB');
    expect(filter).toContain('start_silence=0.5');
  });
});

describe('readSilenceConfig', () => {
  it('returns built-in defaults when env is unset', () => {
    expect(readSilenceConfig({})).toEqual({
      thresholdDb: DEFAULT_SILENCE_THRESHOLD_DB,
      minSilenceSec: DEFAULT_SILENCE_MIN_SEC,
    });
  });

  it('honours valid env overrides', () => {
    expect(readSilenceConfig({ SILENCE_THRESHOLD_DB: '-40', SILENCE_MIN_SEC: '2' })).toEqual({
      thresholdDb: -40,
      minSilenceSec: 2,
    });
  });

  it('rejects threshold above 0 dB (silence-everywhere bug)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readSilenceConfig({ SILENCE_THRESHOLD_DB: '5' }).thresholdDb).toBe(
      DEFAULT_SILENCE_THRESHOLD_DB,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects min-silence below 0.01 sec (trim-one-sample bug)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readSilenceConfig({ SILENCE_MIN_SEC: '0' }).minSilenceSec).toBe(DEFAULT_SILENCE_MIN_SEC);
    expect(readSilenceConfig({ SILENCE_MIN_SEC: '-1' }).minSilenceSec).toBe(
      DEFAULT_SILENCE_MIN_SEC,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects non-finite garbage values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readSilenceConfig({ SILENCE_THRESHOLD_DB: 'banana' }).thresholdDb).toBe(
      DEFAULT_SILENCE_THRESHOLD_DB,
    );
    expect(readSilenceConfig({ SILENCE_MIN_SEC: 'NaN' }).minSilenceSec).toBe(
      DEFAULT_SILENCE_MIN_SEC,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('silenceTrim — input validation', () => {
  it('rejects on missing inputPath', async () => {
    await expect(silenceTrim({ inputPath: '', outputPath: '/out' })).rejects.toThrow(/inputPath/);
  });

  it('rejects on missing outputPath', async () => {
    await expect(silenceTrim({ inputPath: '/in', outputPath: '' })).rejects.toThrow(/outputPath/);
  });
});

describe('silenceTrim — spawn arg shape', () => {
  it('invokes ffmpeg with the right args (-y, -loglevel error, -i, -af, output)', async () => {
    let recordedBinary = '';
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((binary: string, args: readonly string[]) => {
      recordedBinary = binary;
      recordedArgs = args;
      // Resolve on next tick.
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });

    await silenceTrim({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      ffmpegBinary: 'my-ffmpeg',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });

    expect(recordedBinary).toBe('my-ffmpeg');
    expect(recordedArgs).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/in.wav',
      '-af',
      buildFilterChain(DEFAULT_SILENCE_THRESHOLD_DB, DEFAULT_SILENCE_MIN_SEC),
      '/out.wav',
    ]);
  });

  it('threads custom threshold + min-silence through to the filter arg', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });

    await silenceTrim({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      thresholdDb: -30,
      minSilenceSec: 2.5,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });

    const filterArg = recordedArgs[recordedArgs.indexOf('-af') + 1];
    expect(filterArg).toContain('start_threshold=-30dB');
    expect(filterArg).toContain('start_silence=2.5');
  });
});

describe('silenceTrim — success', () => {
  it('resolves with the trimmed result + stderr tail on exit code 0', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('size=1024 time=00:00:05\n'));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });

    const result = await silenceTrim({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.inputPath).toBe('/in.wav');
    expect(result.outputPath).toBe('/out.wav');
    expect(result.thresholdDb).toBe(DEFAULT_SILENCE_THRESHOLD_DB);
    expect(result.minSilenceSec).toBe(DEFAULT_SILENCE_MIN_SEC);
    expect(result.stderrTail).toContain('size=1024');
  });
});

describe('silenceTrim — failure modes', () => {
  it('rejects with SilenceTrimError on non-zero exit code, including stderr tail', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('No such file or directory\n'));
        fakeProc.emit('close', 1);
      });
      return fakeProc;
    });

    try {
      await silenceTrim({
        inputPath: '/missing.wav',
        outputPath: '/out.wav',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(SilenceTrimError);
      expect((err as SilenceTrimError).code).toBe(1);
      expect((err as SilenceTrimError).stderr).toContain('No such file');
    }
  });

  it('rejects with SilenceTrimError on spawn-thrown error', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT: ffmpeg not found');
    }) as unknown as typeof SpawnFn;

    try {
      await silenceTrim({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        spawnFn,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(SilenceTrimError);
      expect((err as SilenceTrimError).message).toContain('ENOENT');
    }
  });

  it('rejects on emitted error event after spawn', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit('error', new Error('EACCES')));
      return fakeProc;
    });

    await expect(
      silenceTrim({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      }),
    ).rejects.toBeInstanceOf(SilenceTrimError);
  });
});

describe('silenceTrim — stderr UTF-8 boundary safety', () => {
  it('does not split a multi-byte UTF-8 char across the rolling-byte boundary', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        // 4090 bytes of ASCII filler, then a 4-byte emoji ("🚀"
        // = F0 9F 9A 80) so the previous tail (4090) + 4 emoji
        // bytes = 4094 bytes total. Well within the 4 KB
        // window — emoji should round-trip cleanly.
        fakeProc.stderr.emit('data', Buffer.from('A'.repeat(4090)));
        fakeProc.stderr.emit('data', Buffer.from('🚀', 'utf8'));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await silenceTrim({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.stderrTail.endsWith('🚀')).toBe(true);
  });
});

describe('silenceTrim — stderr tail truncation', () => {
  it('caps captured stderr at the configured byte budget', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        // Push 8KB of stderr; helper retains last 4KB.
        fakeProc.stderr.emit('data', Buffer.from('A'.repeat(8192)));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await silenceTrim({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.stderrTail.length).toBe(4096);
  });
});
