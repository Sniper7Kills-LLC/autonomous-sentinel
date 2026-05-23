import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as SpawnFn } from 'node:child_process';
import {
  OPUS_APPLICATION,
  OPUS_BITRATE,
  OPUS_CHANNELS,
  OPUS_SAMPLE_RATE_HZ,
  TranscodeOpusError,
  WEB_CANONICAL_S3_METADATA,
  buildArgs,
  transcodeOpus,
  webCanonicalKey,
} from './opus-transcode';

/**
 * Behaviour tests for the Opus transcode helper (#52).
 *
 * Drives `transcodeOpus` through a stubbed spawn so vitest
 * never shells out to a real ffmpeg. Pins the canonical
 * encoding params, arg shape, success + failure paths,
 * input validation, and the S3 key + metadata helpers.
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

describe('canonical encoding constants', () => {
  it('pins 32 kbps mono 16 kHz voip — the canonical web playback derivative', () => {
    expect(OPUS_BITRATE).toBe('32k');
    expect(OPUS_CHANNELS).toBe(1);
    expect(OPUS_SAMPLE_RATE_HZ).toBe(16_000);
    expect(OPUS_APPLICATION).toBe('voip');
  });
});

describe('buildArgs', () => {
  it('produces the canonical ffmpeg argv for Opus transcode', () => {
    expect(buildArgs('/in.wav', '/out.opus')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-i',
      '/in.wav',
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
      '/out.opus',
    ]);
  });
});

describe('transcodeOpus — input validation', () => {
  it('rejects missing inputPath', async () => {
    await expect(transcodeOpus({ inputPath: '', outputPath: '/out.opus' })).rejects.toThrow(
      /inputPath/,
    );
  });

  it('rejects missing outputPath', async () => {
    await expect(transcodeOpus({ inputPath: '/in', outputPath: '' })).rejects.toThrow(/outputPath/);
  });

  it('rejects inputPath === outputPath (would clobber input)', async () => {
    await expect(
      transcodeOpus({ inputPath: '/same.opus', outputPath: '/same.opus' }),
    ).rejects.toThrow(/must differ/);
  });
});

describe('transcodeOpus — spawn arg shape', () => {
  it('invokes ffmpeg with the canonical args + custom binary', async () => {
    let recordedBinary = '';
    let recordedArgs: readonly string[] = [];
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn((binary: string, args: readonly string[]) => {
      recordedBinary = binary;
      recordedArgs = args;
      queueMicrotask(() => fakeProc.emit('close', 0));
      return fakeProc;
    });
    await transcodeOpus({
      inputPath: '/in.wav',
      outputPath: '/out.opus',
      ffmpegBinary: 'my-ffmpeg',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(recordedBinary).toBe('my-ffmpeg');
    expect(recordedArgs).toEqual(buildArgs('/in.wav', '/out.opus'));
  });
});

describe('transcodeOpus — success', () => {
  it('resolves with encoding metadata + stderr tail on exit 0', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('size=128KiB time=00:01:00\n'));
        fakeProc.emit('close', 0);
      });
      return fakeProc;
    });
    const result = await transcodeOpus({
      inputPath: '/in.wav',
      outputPath: '/out.opus',
      spawnFn: spawnFn as unknown as typeof SpawnFn,
    });
    expect(result).toMatchObject({
      inputPath: '/in.wav',
      outputPath: '/out.opus',
      bitrate: OPUS_BITRATE,
      channels: OPUS_CHANNELS,
      sampleRateHz: OPUS_SAMPLE_RATE_HZ,
      application: OPUS_APPLICATION,
    });
    expect(result.stderrTail).toContain('size=128KiB');
  });
});

describe('transcodeOpus — failure modes', () => {
  it('rejects with TranscodeOpusError on non-zero ffmpeg exit', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        fakeProc.stderr.emit('data', Buffer.from('Invalid argument\n'));
        fakeProc.emit('close', 1);
      });
      return fakeProc;
    });
    try {
      await transcodeOpus({
        inputPath: '/in.wav',
        outputPath: '/out.opus',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscodeOpusError);
      expect((err as TranscodeOpusError).code).toBe(1);
      expect((err as TranscodeOpusError).stderr).toContain('Invalid argument');
    }
  });

  it('rejects with TranscodeOpusError on spawn-thrown error', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT: ffmpeg not found');
    }) as unknown as typeof SpawnFn;
    await expect(
      transcodeOpus({ inputPath: '/in.wav', outputPath: '/out.opus', spawnFn }),
    ).rejects.toBeInstanceOf(TranscodeOpusError);
  });

  it('rejects with TranscodeOpusError on emitted error event', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => fakeProc.emit('error', new Error('EACCES')));
      return fakeProc;
    });
    await expect(
      transcodeOpus({
        inputPath: '/in.wav',
        outputPath: '/out.opus',
        spawnFn: spawnFn as unknown as typeof SpawnFn,
      }),
    ).rejects.toBeInstanceOf(TranscodeOpusError);
  });
});

describe('webCanonicalKey + WEB_CANONICAL_S3_METADATA', () => {
  it('builds the recordings/web/<id>.opus key shape', () => {
    expect(webCanonicalKey('rec-abc')).toBe('recordings/web/rec-abc.opus');
  });

  it('throws on missing recordingId', () => {
    expect(() => webCanonicalKey('')).toThrow(/recordingId required/);
  });

  it('pins the audio/ogg + immutable cache-control metadata for CloudFront', () => {
    expect(WEB_CANONICAL_S3_METADATA.contentType).toBe('audio/ogg; codecs=opus');
    expect(WEB_CANONICAL_S3_METADATA.cacheControl).toBe('public, max-age=31536000, immutable');
  });
});
