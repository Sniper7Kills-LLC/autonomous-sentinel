import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as SpawnFn } from 'node:child_process';
import {
  DEFAULT_WHISPER_BINARY,
  DEFAULT_WHISPER_LANGUAGE,
  DEFAULT_WHISPER_MODEL_PATH,
  DEFAULT_WHISPER_THREADS,
  WhisperError,
  buildArgs,
  readWhisperConfig,
  runWhisper,
} from './run-whisper.mjs';

/**
 * Behaviour tests for the whisper.cpp invocation helper (#53).
 *
 * Drives `runWhisper` through a stubbed spawn so vitest never
 * shells out to a real whisper binary. Pins the arg shape,
 * env config resolution, success + failure paths, same-path
 * rejection, and stderr tail capture.
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

describe('buildArgs', () => {
  it('produces the canonical whisper.cpp argv', () => {
    expect(
      buildArgs({
        inputPath: '/tmp/in.opus',
        outputPrefix: '/tmp/out',
        language: 'en',
        threads: 4,
        modelPath: '/opt/models/medium.en.bin',
      }),
    ).toEqual([
      '-m',
      '/opt/models/medium.en.bin',
      '-f',
      '/tmp/in.opus',
      '-l',
      'en',
      '-t',
      '4',
      '-oj',
      '-of',
      '/tmp/out',
    ]);
  });

  it('never emits bare "true" / "false" tokens — whisper.cpp would read them as positional input paths (#450)', () => {
    const args = buildArgs({
      inputPath: '/tmp/in.opus',
      outputPrefix: '/tmp/out',
      language: 'en',
      threads: 4,
      modelPath: '/opt/models/medium.en.bin',
    });
    // whisper.cpp's boolean options (e.g. `--print-progress`) are
    // presence flags — a trailing `'false'` is parsed as a
    // positional input file path. Catch any future regression
    // that pairs a flag with a literal bool value.
    expect(args).not.toContain('false');
    expect(args).not.toContain('true');
  });
});

describe('readWhisperConfig', () => {
  it('returns built-in defaults when env is unset', () => {
    expect(readWhisperConfig({})).toEqual({
      whisperBinary: DEFAULT_WHISPER_BINARY,
      modelPath: DEFAULT_WHISPER_MODEL_PATH,
      language: DEFAULT_WHISPER_LANGUAGE,
      threads: DEFAULT_WHISPER_THREADS,
    });
  });

  it('honours valid env overrides', () => {
    expect(
      readWhisperConfig({
        WHISPER_BINARY: '/usr/local/bin/whisper',
        WHISPER_MODEL_PATH: '/opt/models/large.bin',
        WHISPER_LANGUAGE: 'es',
        WHISPER_THREADS: '8',
      }),
    ).toEqual({
      whisperBinary: '/usr/local/bin/whisper',
      modelPath: '/opt/models/large.bin',
      language: 'es',
      threads: 8,
    });
  });

  it('rejects threads outside [1, 16] with a warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readWhisperConfig({ WHISPER_THREADS: '0' }).threads).toBe(DEFAULT_WHISPER_THREADS);
    expect(readWhisperConfig({ WHISPER_THREADS: '17' }).threads).toBe(DEFAULT_WHISPER_THREADS);
    expect(readWhisperConfig({ WHISPER_THREADS: '2.5' }).threads).toBe(DEFAULT_WHISPER_THREADS);
    expect(readWhisperConfig({ WHISPER_THREADS: 'banana' }).threads).toBe(DEFAULT_WHISPER_THREADS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('runWhisper — input validation', () => {
  it('rejects missing inputPath', async () => {
    await expect(runWhisper({ inputPath: '', outputPrefix: '/tmp/out' })).rejects.toThrow(
      /inputPath/,
    );
  });

  it('rejects missing outputPrefix', async () => {
    await expect(runWhisper({ inputPath: '/tmp/in', outputPrefix: '' })).rejects.toThrow(
      /outputPrefix/,
    );
  });

  it('rejects identical inputPath === outputPrefix', async () => {
    await expect(runWhisper({ inputPath: '/tmp/x', outputPrefix: '/tmp/x' })).rejects.toThrow(
      /must differ/,
    );
  });
});

describe('runWhisper — spawn arg shape', () => {
  it('invokes whisper binary with canonical args + custom binary', async () => {
    let recordedBinary = '';
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((binary: string, args: readonly string[]) => {
      recordedBinary = binary;
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await runWhisper({
      inputPath: '/tmp/in.opus',
      outputPrefix: '/tmp/out',
      whisperBinary: '/my/whisper',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(recordedBinary).toBe('/my/whisper');
    expect(recordedArgs).toEqual(
      buildArgs({
        inputPath: '/tmp/in.opus',
        outputPrefix: '/tmp/out',
        language: DEFAULT_WHISPER_LANGUAGE,
        threads: DEFAULT_WHISPER_THREADS,
        modelPath: DEFAULT_WHISPER_MODEL_PATH,
      }),
    );
  });

  it('threads custom language + threads + modelPath into the args', async () => {
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((_b: string, args: readonly string[]) => {
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await runWhisper({
      inputPath: '/tmp/in.opus',
      outputPrefix: '/tmp/out',
      language: 'es',
      threads: 8,
      modelPath: '/opt/models/large.bin',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(recordedArgs[recordedArgs.indexOf('-l') + 1]).toBe('es');
    expect(recordedArgs[recordedArgs.indexOf('-t') + 1]).toBe('8');
    expect(recordedArgs[recordedArgs.indexOf('-m') + 1]).toBe('/opt/models/large.bin');
  });
});

describe('runWhisper — success', () => {
  it('resolves with jsonOutputPath + metadata + stderr tail on exit 0', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('whisper_print_timings: load time =\n'));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await runWhisper({
      inputPath: '/tmp/in.opus',
      outputPrefix: '/tmp/rec-1',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result).toMatchObject({
      inputPath: '/tmp/in.opus',
      outputPrefix: '/tmp/rec-1',
      jsonOutputPath: '/tmp/rec-1.json',
      language: DEFAULT_WHISPER_LANGUAGE,
      threads: DEFAULT_WHISPER_THREADS,
      modelPath: DEFAULT_WHISPER_MODEL_PATH,
    });
    expect(result.stderrTail).toContain('load time');
  });
});

describe('runWhisper — failure modes', () => {
  it('rejects with WhisperError on non-zero exit, carrying stderr tail', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit(
          'data',
          Buffer.from('whisper_init_from_file_with_params_no_state: failed to load model\n'),
        );
        fakeProc.emit('close', 1);
      });
      return fakeProc;
    });
    try {
      await runWhisper({
        inputPath: '/tmp/in.opus',
        outputPrefix: '/tmp/out',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(WhisperError);
      expect((err as WhisperError).code).toBe(1);
      expect((err as WhisperError).stderr).toContain('failed to load model');
    }
  });

  it('rejects with WhisperError on spawn-thrown error', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT: /opt/whisper not found');
    }) as unknown as typeof SpawnFn;
    await expect(
      runWhisper({ inputPath: '/tmp/in', outputPrefix: '/tmp/out', spawnFn }),
    ).rejects.toBeInstanceOf(WhisperError);
  });

  it('rejects with WhisperError on emitted error event', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit('error', new Error('EACCES')));
      return fakeProc;
    });
    await expect(
      runWhisper({
        inputPath: '/tmp/in',
        outputPrefix: '/tmp/out',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      }),
    ).rejects.toBeInstanceOf(WhisperError);
  });
});
