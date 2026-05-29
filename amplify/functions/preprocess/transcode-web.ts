import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  transcodeOpus,
  webCanonicalKey,
  WEB_CANONICAL_S3_METADATA,
  type TranscodeOpusOpts,
  type TranscodeOpusResult,
} from './opus-transcode';

/**
 * Produce the web-canonical Opus derivative for a recording (#503).
 *
 * Downloads the original from S3 to Lambda's `/tmp`, runs the ffmpeg
 * Opus 32 kbps mono transcode (`opus-transcode.ts`), and uploads the
 * result to `recordings/web/<id>.opus`. Returns the web key + byte
 * size so the handler can write `webCanonicalKey` + `canonicalSizeBytes`
 * onto the Recording row.
 *
 * The ffmpeg binary path comes from `ffmpegBinary` (the handler passes
 * `process.env.FFMPEG_PATH`, set to the Lambda layer's `/opt/bin/ffmpeg`
 * once the layer is provisioned). Until the layer lands the handler
 * keeps the byte-copy fallback and never calls this.
 *
 * `transcode` is injectable so unit tests drive the orchestration
 * (download → transcode → upload) without a real ffmpeg.
 */
export interface TranscodeWebDeps {
  s3: S3Client;
  transcode?: (opts: TranscodeOpusOpts) => Promise<TranscodeOpusResult>;
  ffmpegBinary?: string;
}

export interface TranscodeWebInput {
  bucket: string;
  originalKey: string;
  recordingId: string;
  contentHash?: string;
}

export interface TranscodeWebResult {
  webKey: string;
  sizeBytes: number;
}

function extensionOf(key: string): string {
  const dot = key.lastIndexOf('.');
  const slash = key.lastIndexOf('/');
  return dot > slash ? key.slice(dot) : '';
}

export async function transcodeWebCanonical(
  input: TranscodeWebInput,
  deps: TranscodeWebDeps,
): Promise<TranscodeWebResult> {
  const transcode = deps.transcode ?? transcodeOpus;
  const webKey = webCanonicalKey(input.recordingId);

  const dir = await mkdtemp(join(tmpdir(), `preprocess-${input.recordingId}-`));
  try {
    const inputPath = join(dir, `original${extensionOf(input.originalKey)}`);
    const outputPath = join(dir, 'web.opus');

    const obj = await deps.s3.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.originalKey }),
    );
    if (!obj.Body) {
      throw new Error(`transcodeWebCanonical: empty S3 body for ${input.originalKey}`);
    }
    await writeFile(inputPath, Buffer.from(await obj.Body.transformToByteArray()));

    await transcode({ inputPath, outputPath, ffmpegBinary: deps.ffmpegBinary });

    const opus = await readFile(outputPath);
    await deps.s3.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: webKey,
        Body: opus,
        ContentType: WEB_CANONICAL_S3_METADATA.contentType,
        CacheControl: WEB_CANONICAL_S3_METADATA.cacheControl,
        Metadata: {
          'recording-id': input.recordingId,
          ...(input.contentHash ? { 'content-hash': input.contentHash } : {}),
        },
      }),
    );

    return { webKey, sizeBytes: opus.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
