import type { S3Handler } from 'aws-lambda';

export const handler: S3Handler = async (event) => {
  await Promise.resolve();
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    console.info('preprocess: received', { bucket, key });
    // TODO: ffmpeg preprocess + transcode to recordings/web/{id}.opus
    // TODO: emit EventBridge event for transcribe stage
  }
};
