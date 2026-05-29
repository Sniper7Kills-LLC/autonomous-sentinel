import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildFfmpegArgs,
  buildWavArgs,
  transcodeToOpus,
  transcodeToWav,
  TranscodeError,
} from './opus-transcode.mjs';

/**
 * Behaviour tests for the in-container ffmpeg → Opus helper (#514).
 * Drives `transcodeToOpus` through a stubbed spawn so vitest never
 * shells out to a real ffmpeg.
 */

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  return proc;
}

describe('buildFfmpegArgs', () => {
  it('produces the canonical Opus 32k mono argv', () => {
    expect(buildFfmpegArgs('/tmp/in.wav', '/tmp/out.opus')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/tmp/in.wav',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-application',
      'voip',
      '-vbr',
      'on',
      '/tmp/out.opus',
    ]);
  });
});

describe('buildWavArgs', () => {
  it('produces 16 kHz mono pcm_s16le argv (whisper.cpp input)', () => {
    expect(buildWavArgs('/tmp/in.mp3', '/tmp/out.wav')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/tmp/in.mp3',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '/tmp/out.wav',
    ]);
  });
});

describe('transcodeToWav', () => {
  it('resolves on exit 0', async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn(() => proc) as never;
    const p = transcodeToWav({ inputPath: '/tmp/in.mp3', outputPath: '/tmp/out.wav', spawnFn });
    proc.emit('close', 0);
    await expect(p).resolves.toEqual(expect.objectContaining({ outputPath: '/tmp/out.wav' }));
  });

  it('rejects with TranscodeError on non-zero exit', async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn(() => proc) as never;
    const p = transcodeToWav({ inputPath: '/tmp/in.mp3', outputPath: '/tmp/out.wav', spawnFn });
    proc.emit('close', 1);
    await expect(p).rejects.toBeInstanceOf(TranscodeError);
  });
});

describe('transcodeToOpus', () => {
  it('resolves with the output path + stderr tail on exit 0', async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn(() => proc) as never;
    const p = transcodeToOpus({
      inputPath: '/tmp/in.wav',
      outputPath: '/tmp/out.opus',
      ffmpegPath: '/usr/local/bin/ffmpeg',
      spawnFn,
    });
    proc.stderr.emit('data', Buffer.from('size=...'));
    proc.emit('close', 0);
    await expect(p).resolves.toEqual({ outputPath: '/tmp/out.opus', stderrTail: 'size=...' });
    expect((spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      '/usr/local/bin/ffmpeg',
    );
  });

  it('rejects with TranscodeError on a non-zero exit', async () => {
    const proc = makeFakeProc();
    const spawnFn = vi.fn(() => proc) as never;
    const p = transcodeToOpus({
      inputPath: '/tmp/in.wav',
      outputPath: '/tmp/out.opus',
      spawnFn,
    });
    proc.stderr.emit('data', Buffer.from('Invalid data'));
    proc.emit('close', 1);
    await expect(p).rejects.toBeInstanceOf(TranscodeError);
  });

  it('rejects when input and output are the same path', async () => {
    await expect(transcodeToOpus({ inputPath: '/tmp/a', outputPath: '/tmp/a' })).rejects.toThrow(
      /must differ/,
    );
  });

  it('rejects when inputPath is missing', async () => {
    await expect(transcodeToOpus({ outputPath: '/tmp/out.opus' } as never)).rejects.toThrow(
      /inputPath/,
    );
  });
});
