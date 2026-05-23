import { describe, it, beforeEach, afterEach } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { attachStorageLifecycle, readStorageLifecycleConfig } from './storage-lifecycle';

/**
 * Synth-shape tests for the S3 lifecycle + versioning + CORS +
 * encryption configuration applied to the autonomous-sentinel media
 * bucket (#44 versioning, #45 recordings retention, #47 pipeline-
 * temp expiry, #48 exports expiry). Mirrors the `budgets.test.ts`
 * Template-from-stack pattern.
 *
 * The helper operates on a generic `IBucket` so we can stand up a
 * plain CDK `Bucket` in a test stack and verify the rules without
 * needing the full Amplify backend graph.
 */

function synth(env: Record<string, string | undefined> = {}): Template {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const bucket = new Bucket(stack, 'TestBucket');
    attachStorageLifecycle(bucket, readStorageLifecycleConfig());
    return Template.fromStack(stack);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('attachStorageLifecycle — versioning (#44)', () => {
  beforeEach(() => {
    delete process.env.AS_STORAGE_CORS_ORIGINS;
  });
  afterEach(() => {
    delete process.env.AS_STORAGE_CORS_ORIGINS;
  });

  it('enables bucket versioning so noncurrent versions survive delete-marker creation', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });
});

describe('attachStorageLifecycle — server-side encryption (#44, #48)', () => {
  it('pins SSE-S3 (AES256) as the bucket-default encryption algorithm', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      }),
    });
  });
});

describe('attachStorageLifecycle — CORS', () => {
  it('allows GET/HEAD/PUT/POST/DELETE on the default origin pair', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: Match.objectLike({
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(['GET', 'HEAD', 'PUT', 'POST', 'DELETE']),
            AllowedOrigins: Match.arrayWith(['http://localhost:3000', 'https://beta.eam.watch']),
          }),
        ]),
      }),
    });
  });

  it('honours AS_STORAGE_CORS_ORIGINS when set (comma-separated list)', () => {
    const t = synth({
      AS_STORAGE_CORS_ORIGINS: 'https://eam.watch,https://staging.eam.watch',
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: Match.objectLike({
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedOrigins: ['https://eam.watch', 'https://staging.eam.watch'],
          }),
        ]),
      }),
    });
  });

  it('exposes ETag + x-amz-version-id so multipart-resumable uploads can track versions', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: Match.objectLike({
        CorsRules: Match.arrayWith([
          Match.objectLike({
            ExposedHeaders: Match.arrayWith(['ETag', 'x-amz-version-id']),
          }),
        ]),
      }),
    });
  });
});

describe('attachStorageLifecycle — lifecycle rules (#45, #47, #48)', () => {
  it('expires recordings/ noncurrent versions after 30 days + cleans empty delete markers (#45)', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'recordings-noncurrent-30d',
            Status: 'Enabled',
            Prefix: 'recordings/',
            NoncurrentVersionExpiration: Match.objectLike({
              NoncurrentDays: 30,
            }),
            ExpiredObjectDeleteMarker: true,
          }),
        ]),
      }),
    });
  });

  it('expires pipeline-temp/ objects after 7 days + aborts incomplete multipart at 1 day (#47)', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'pipeline-temp-7d',
            Status: 'Enabled',
            Prefix: 'pipeline-temp/',
            ExpirationInDays: 7,
            AbortIncompleteMultipartUpload: Match.objectLike({
              DaysAfterInitiation: 1,
            }),
          }),
        ]),
      }),
    });
  });

  it('expires exports/ objects after 7 days (#48)', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'exports-7d',
            Status: 'Enabled',
            Prefix: 'exports/',
            ExpirationInDays: 7,
          }),
        ]),
      }),
    });
  });
});
