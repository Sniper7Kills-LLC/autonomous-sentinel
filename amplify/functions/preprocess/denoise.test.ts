import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as SpawnFn } from 'node:child_process';
import {
  DEFAULT_NF_DB,
  DEFAULT_NOISE_REDUCTION_MODE,
  DEFAULT_NR_DB,
  DenoiseError,
  NOISE_REDUCTION_MODES,
  RnnoiseModelMissing,
  buildAfftdnFilter,
  buildArnndnFilter,
  denoise,
  isNoiseReductionMode,
  readDenoiseConfig,
} from './denoise';

/**
 * Behaviour tests for the denoise helper (#51).
 *
 * Drives `denoise` through a stubbed spawn + copyFile so vitest
 * never shells out / touches the real filesystem. Pins the
 * mode dispatch, env config resolution, filter shape, success,
 * non-zero exit + spawn-error failure modes, and rnnoise
 * deferred-throw.
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

describe('isNoiseReductionMode + NOISE_REDUCTION_MODES', () => {
  it('accepts each mode enum value', () => {
    for (const m of NOISE_REDUCTION_MODES) expect(isNoiseReductionMode(m)).toBe(true);
  });

  it('rejects unknown / null / non-string', () => {
    expect(isNoiseReductionMode('OFF')).toBe(false);
    expect(isNoiseReductionMode('')).toBe(false);
    expect(isNoiseReductionMode(null)).toBe(false);
    expect(isNoiseReductionMode(undefined)).toBe(false);
    expect(isNoiseReductionMode(42)).toBe(false);
  });
});

describe('buildAfftdnFilter', () => {
  it('produces the afftdn filter expression', () => {
    expect(buildAfftdnFilter(12, -25)).toBe('afftdn=nr=12:nf=-25');
  });

  it('honours custom values', () => {
    expect(buildAfftdnFilter(20, -40)).toBe('afftdn=nr=20:nf=-40');
  });
});

describe('buildArnndnFilter', () => {
  it('produces the arnndn filter expression with the model path', () => {
    expect(buildArnndnFilter('/opt/models/sh.rnnn')).toBe('arnndn=m=/opt/models/sh.rnnn');
  });
});

describe('readDenoiseConfig', () => {
  it('returns built-in defaults when env is unset', () => {
    expect(readDenoiseConfig({})).toEqual({
      mode: DEFAULT_NOISE_REDUCTION_MODE,
      nrDb: DEFAULT_NR_DB,
      nfDb: DEFAULT_NF_DB,
      rnnoiseModelPath: null,
    });
  });

  it('honours valid env overrides', () => {
    expect(
      readDenoiseConfig({
        NOISE_REDUCTION_MODE: 'off',
        NOISE_REDUCTION_NR_DB: '20',
        NOISE_REDUCTION_NF_DB: '-35',
      }),
    ).toEqual({ mode: 'off', nrDb: 20, nfDb: -35, rnnoiseModelPath: null });
  });

  it('reads the rnnoise model path from env', () => {
    expect(
      readDenoiseConfig({
        NOISE_REDUCTION_MODE: 'rnnoise',
        NOISE_REDUCTION_RNNOISE_MODEL: '/opt/models/sh.rnnn',
      }),
    ).toMatchObject({ mode: 'rnnoise', rnnoiseModelPath: '/opt/models/sh.rnnn' });
  });

  it('falls back to default mode + warns on unknown mode value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readDenoiseConfig({ NOISE_REDUCTION_MODE: 'banana' }).mode).toBe(
      DEFAULT_NOISE_REDUCTION_MODE,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects nr-db outside [0, 97] range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readDenoiseConfig({ NOISE_REDUCTION_NR_DB: '-1' }).nrDb).toBe(DEFAULT_NR_DB);
    expect(readDenoiseConfig({ NOISE_REDUCTION_NR_DB: '98' }).nrDb).toBe(DEFAULT_NR_DB);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('rejects nf-db outside [-80, -20] range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readDenoiseConfig({ NOISE_REDUCTION_NF_DB: '-90' }).nfDb).toBe(DEFAULT_NF_DB);
    expect(readDenoiseConfig({ NOISE_REDUCTION_NF_DB: '-10' }).nfDb).toBe(DEFAULT_NF_DB);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('denoise — input validation', () => {
  it('throws on missing inputPath', async () => {
    await expect(denoise({ inputPath: '', outputPath: '/out' })).rejects.toThrow(/inputPath/);
  });

  it('throws on missing outputPath', async () => {
    await expect(denoise({ inputPath: '/in', outputPath: '' })).rejects.toThrow(/outputPath/);
  });

  it('throws when inputPath === outputPath (would clobber input)', async () => {
    await expect(denoise({ inputPath: '/same.wav', outputPath: '/same.wav' })).rejects.toThrow(
      /must differ/,
    );
  });
});

describe('denoise — mode=off', () => {
  it('calls copyFile and resolves with mode=off + null nr/nf + empty stderr', async () => {
    const copyFn = vi.fn(() => Promise.resolve());
    const result = await denoise({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      mode: 'off',
      copyFileFn: copyFn,
    });
    expect(copyFn).toHaveBeenCalledWith('/in.wav', '/out.wav');
    expect(result).toEqual({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      mode: 'off',
      nrDb: null,
      nfDb: null,
      stderrTail: '',
    });
  });

  it('propagates copyFile rejections', async () => {
    const copyFn = vi.fn(() => Promise.reject(new Error('EACCES')));
    await expect(
      denoise({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        mode: 'off',
        copyFileFn: copyFn,
      }),
    ).rejects.toThrow(/EACCES/);
  });
});

describe('denoise — mode=rnnoise (#476)', () => {
  it('fails closed with RnnoiseModelMissing when no model path is configured', async () => {
    const spawnFn = vi.fn(() => makeFakeProc());
    await expect(
      denoise({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        mode: 'rnnoise',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      }),
    ).rejects.toBeInstanceOf(RnnoiseModelMissing);
    // Fail closed — must not silently shell out to afftdn/off.
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('invokes ffmpeg with -af arnndn=m=<model> when a model path is set', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    const result = await denoise({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      mode: 'rnnoise',
      rnnoiseModelPath: '/opt/models/sh.rnnn',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(recordedArgs).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/in.wav',
      '-af',
      'arnndn=m=/opt/models/sh.rnnn',
      '/out.wav',
    ]);
    // arnndn carries no nr/nf tunables.
    expect(result).toMatchObject({ mode: 'rnnoise', nrDb: null, nfDb: null });
  });

  it('fails closed with a DenoiseError when the ffmpeg build lacks arnndn (non-zero exit)', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from("No such filter: 'arnndn'\n"));
        fakeProc.emit('close', 1);
      });
      return fakeProc;
    });
    await expect(
      denoise({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        mode: 'rnnoise',
        rnnoiseModelPath: '/opt/models/sh.rnnn',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      }),
    ).rejects.toBeInstanceOf(DenoiseError);
  });
});

describe('denoise — mode=afftdn (default)', () => {
  it('invokes ffmpeg with -y -loglevel error -i input -af afftdn=... output', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await denoise({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(recordedArgs).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/in.wav',
      '-af',
      buildAfftdnFilter(DEFAULT_NR_DB, DEFAULT_NF_DB),
      '/out.wav',
    ]);
  });

  it('threads custom nrDb + nfDb into the filter', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await denoise({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      nrDb: 20,
      nfDb: -40,
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    const filterArg = recordedArgs[recordedArgs.indexOf('-af') + 1];
    expect(filterArg).toBe('afftdn=nr=20:nf=-40');
  });

  it('resolves with mode=afftdn + applied nr/nf + stderr tail on exit 0', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('size=1024 time=00:00:05\n'));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await denoise({
      inputPath: '/in.wav',
      outputPath: '/out.wav',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result.mode).toBe('afftdn');
    expect(result.nrDb).toBe(DEFAULT_NR_DB);
    expect(result.nfDb).toBe(DEFAULT_NF_DB);
    expect(result.stderrTail).toContain('size=1024');
  });
});

describe('denoise — failure modes', () => {
  it('rejects with DenoiseError on non-zero ffmpeg exit, carrying stderr tail', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('Invalid input format\n'));
        fakeProc.emit('close', 1);
      });
      return fakeProc;
    });
    try {
      await denoise({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(DenoiseError);
      expect((err as DenoiseError).code).toBe(1);
      expect((err as DenoiseError).stderr).toContain('Invalid input format');
    }
  });

  it('rejects with DenoiseError on spawn-thrown error', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT: ffmpeg not found');
    }) as unknown as typeof SpawnFn;
    await expect(
      denoise({ inputPath: '/in.wav', outputPath: '/out.wav', spawnFn }),
    ).rejects.toBeInstanceOf(DenoiseError);
  });

  it('rejects with DenoiseError on emitted error event', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit('error', new Error('EACCES')));
      return fakeProc;
    });
    await expect(
      denoise({
        inputPath: '/in.wav',
        outputPath: '/out.wav',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      }),
    ).rejects.toBeInstanceOf(DenoiseError);
  });
});
