import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildAfftdnFilter,
  readDenoiseConfig,
  isNoiseReductionMode,
  denoise,
  DenoiseError,
  RnnoiseNotImplemented,
  DEFAULT_NOISE_REDUCTION_MODE,
  DEFAULT_NR_DB,
  DEFAULT_NF_DB,
} from './denoise.mjs';

/**
 * Behaviour tests for the in-container denoise helper (#671). Stubbed
 * spawn + copyFile so vitest never shells out / touches the FS.
 */

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  return proc;
}

describe('buildAfftdnFilter', () => {
  it('encodes nr + nf', () => {
    expect(buildAfftdnFilter(12, -25)).toBe('afftdn=nr=12:nf=-25');
  });
});

describe('isNoiseReductionMode', () => {
  it('accepts the three known modes, rejects others', () => {
    expect(isNoiseReductionMode('afftdn')).toBe(true);
    expect(isNoiseReductionMode('off')).toBe(true);
    expect(isNoiseReductionMode('rnnoise')).toBe(true);
    expect(isNoiseReductionMode('bogus')).toBe(false);
    expect(isNoiseReductionMode(undefined)).toBe(false);
  });
});

describe('readDenoiseConfig', () => {
  it('defaults to afftdn with default nr/nf', () => {
    expect(readDenoiseConfig({})).toEqual({
      mode: DEFAULT_NOISE_REDUCTION_MODE,
      nrDb: DEFAULT_NR_DB,
      nfDb: DEFAULT_NF_DB,
    });
  });

  it('honours a valid mode + clamps out-of-range numbers back to defaults', () => {
    expect(
      readDenoiseConfig({ NOISE_REDUCTION_MODE: 'off', NOISE_REDUCTION_NR_DB: '999' }),
    ).toEqual({
      mode: 'off',
      nrDb: DEFAULT_NR_DB,
      nfDb: DEFAULT_NF_DB,
    });
  });

  it('falls back to afftdn on an unknown mode', () => {
    expect(readDenoiseConfig({ NOISE_REDUCTION_MODE: 'magic' }).mode).toBe(
      DEFAULT_NOISE_REDUCTION_MODE,
    );
  });
});

describe('denoise', () => {
  it('rejects when input and output match', async () => {
    await expect(denoise({ inputPath: '/tmp/a.wav', outputPath: '/tmp/a.wav' })).rejects.toThrow(
      'must differ',
    );
  });

  it('off mode is a pure copyFile passthrough — no spawn', async () => {
    const copyFileFn = vi.fn().mockResolvedValue(undefined);
    const spawnFn = vi.fn();
    const res = await denoise({
      inputPath: '/tmp/in.wav',
      outputPath: '/tmp/out.wav',
      mode: 'off',
      copyFileFn: copyFileFn as never,
      spawnFn: spawnFn as never,
    });
    expect(res.mode).toBe('off');
    expect(res.nrDb).toBeNull();
    expect(copyFileFn).toHaveBeenCalledWith('/tmp/in.wav', '/tmp/out.wav');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('rnnoise mode throws RnnoiseNotImplemented (pending #476)', async () => {
    await expect(
      denoise({ inputPath: '/tmp/in.wav', outputPath: '/tmp/out.wav', mode: 'rnnoise' } as never),
    ).rejects.toBeInstanceOf(RnnoiseNotImplemented);
  });

  it('afftdn mode resolves on exit 0 with nr/nf applied', async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn().mockReturnValue(proc);
    const p = denoise({
      inputPath: '/tmp/in.wav',
      outputPath: '/tmp/out.wav',
      mode: 'afftdn',
      ffmpegPath: '/usr/local/bin/ffmpeg',
      spawnFn: spawnFn as never,
    });
    proc.emit('close', 0);
    const res = await p;
    expect(res).toMatchObject({ mode: 'afftdn', nrDb: DEFAULT_NR_DB, nfDb: DEFAULT_NF_DB });
    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('afftdn=nr=12:nf=-25');
  });

  it('afftdn mode rejects with DenoiseError on non-zero exit', async () => {
    const proc = makeFakeProc();
    const p = denoise({
      inputPath: '/tmp/in.wav',
      outputPath: '/tmp/out.wav',
      mode: 'afftdn',
      spawnFn: (() => proc) as never,
    });
    proc.stderr.emit('data', Buffer.from('afftdn failed'));
    proc.emit('close', 3);
    await expect(p).rejects.toMatchObject({
      name: 'DenoiseError',
      code: 3,
      stderr: 'afftdn failed',
    });
    await expect(p).rejects.toBeInstanceOf(DenoiseError);
  });
});
