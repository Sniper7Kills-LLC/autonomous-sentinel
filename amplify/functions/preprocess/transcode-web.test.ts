import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { transcodeWebCanonical } from './transcode-web';
import type { TranscodeOpusOpts } from './opus-transcode';

/**
 * Orchestration test for the web-canonical Opus transcode (#503):
 * download original → ffmpeg transcode → upload .opus. The ffmpeg
 * step is stubbed (writes a fake output file); S3 is stubbed.
 */

function makeS3(originalBytes: Uint8Array) {
  const putCalls: Array<Record<string, unknown>> = [];
  const send = vi.fn((cmd: unknown) => {
    const input = (cmd as { input: Record<string, unknown> }).input;
    if ('Key' in input && typeof input.Key === 'string' && input.Body === undefined) {
      // GetObject
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(originalBytes) },
      });
    }
    // PutObject
    putCalls.push(input);
    return Promise.resolve({});
  });
  return { s3: { send } as never, send, putCalls };
}

describe('transcodeWebCanonical (#503)', () => {
  it('downloads, transcodes, and uploads the .opus derivative', async () => {
    const { s3, putCalls } = makeS3(new Uint8Array([1, 2, 3, 4]));
    // ffmpeg stub writes a fake opus output so the upload read succeeds.
    const transcode = vi.fn(async (opts: TranscodeOpusOpts) => {
      await writeFile(opts.outputPath, Buffer.from('OPUSDATA'));
      return {
        inputPath: opts.inputPath,
        outputPath: opts.outputPath,
        bitrate: '32k',
        channels: 1,
        sampleRateHz: 16000,
        application: 'voip',
        stderrTail: '',
      };
    });

    const out = await transcodeWebCanonical(
      {
        bucket: 'media',
        originalKey: 'recordings/originals/abc.wav',
        recordingId: 'rec-123',
        contentHash: 'abc',
      },
      { s3, transcode, ffmpegBinary: '/opt/bin/ffmpeg' },
    );

    expect(out.webKey).toBe('recordings/web/rec-123.opus');
    expect(out.sizeBytes).toBe('OPUSDATA'.length);

    // ffmpeg was invoked with the configured binary path.
    expect(transcode).toHaveBeenCalledOnce();
    expect(transcode.mock.calls[0]?.[0].ffmpegBinary).toBe('/opt/bin/ffmpeg');

    // The upload targets the web key with the opus content type.
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.Key).toBe('recordings/web/rec-123.opus');
    expect(putCalls[0]?.ContentType).toBe('audio/ogg; codecs=opus');
  });

  it('rejects when the original S3 object has no body', async () => {
    const send = vi.fn(() => Promise.resolve({ Body: undefined }));
    await expect(
      transcodeWebCanonical(
        { bucket: 'media', originalKey: 'recordings/originals/x.wav', recordingId: 'rec-9' },
        { s3: { send } as never },
      ),
    ).rejects.toThrow(/empty S3 body/);
  });
});
