import { type CfnBucket, HttpMethods, type IBucket } from 'aws-cdk-lib/aws-s3';
// Duration intentionally not imported — all lifecycle values
// flow through the L1 CfnBucket schema which expects raw integer
// days (#44 / #45 / #47 / #48). The L2 Duration helper is for the
// `bucket.addLifecycleRule(...)` path we're not taking here.

/**
 * S3 lifecycle + versioning + CORS + encryption configuration for
 * the autonomous-sentinel media bucket (#44, #45, #47, #48).
 *
 * Applied via CDK L1 escape-hatch on the bucket Amplify Gen 2's
 * `defineStorage()` creates — those knobs are not surfaced on the
 * `defineStorage` config object today, so we reach into the
 * `defaultChild` CfnBucket and overlay them.
 *
 * Behaviour:
 *   - **Versioning ENABLED** account-wide on the bucket (#44). The
 *     `recordings/originals/*` prefix is the archival "exactly-as-
 *     uploaded" copy that the recording-deletion policy soft-deletes
 *     by creating a delete marker — the previous version stays
 *     restorable for the 30-day delete-marker retention window.
 *
 *   - **Lifecycle rules**:
 *       1. `recordings/*` — 30-day noncurrent-version expiration +
 *          expired-delete-marker self-clean (#45). Restores within
 *          the 30-day window are a console-side delete of the
 *          delete-marker version (runbook deferred — file follow-up
 *          when admin UI lands).
 *       2. `pipeline-temp/*` — 7-day object expiration + 1-day
 *          abort-incomplete-multipart (#47). Lifecycle is the
 *          *safety net*; pre-process / transcribe handlers must
 *          `DeleteObject` on every temp key on success path.
 *       3. `exports/*` — 7-day object expiration (#48). Bulk-
 *          download zips are temporary download links; the requester
 *          must fetch within the window or re-request.
 *
 *   - **Server-side encryption**: SSE-S3 (AES256) bucket default
 *     (#44 + #48). SSE-KMS upgrade tracked as a future follow-up if
 *     compliance ever demands it.
 *
 *   - **CORS**: allows PUT/POST/GET from the web app + Electron
 *     upload-client origin set so multipart resumable uploads work
 *     from the browser/desktop without leaking S3 origin to the
 *     general internet. The web origin list is env-driven so a
 *     future cutover from `beta.eam.watch` to `eam.watch` does not
 *     need a code change.
 *
 * `attachStorageLifecycle` is exported standalone so the synth-shape
 * tests in `storage-lifecycle.test.ts` can verify the rules against
 * a CFN Template without invoking the full `defineBackend()` graph.
 *
 * Env-driven origin overrides (comma-separated):
 *   - `AS_STORAGE_CORS_ORIGINS` — defaults to a localhost +
 *     `https://beta.eam.watch` pair so dev + sandbox + Hosting all
 *     work out of the box. Production cutover bumps this to include
 *     `https://eam.watch`.
 */

const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'https://beta.eam.watch'];

function readCorsOrigins(): string[] {
  const raw = process.env.AS_STORAGE_CORS_ORIGINS;
  if (!raw) return DEFAULT_CORS_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface StorageLifecycleConfig {
  corsOrigins: string[];
}

export function readStorageLifecycleConfig(): StorageLifecycleConfig {
  return { corsOrigins: readCorsOrigins() };
}

export function attachStorageLifecycle(
  bucket: IBucket,
  config: StorageLifecycleConfig = readStorageLifecycleConfig(),
): void {
  const cfnBucket = bucket.node.defaultChild as CfnBucket;

  // Versioning ENABLED — the recordings/originals/* archival copy
  // relies on noncurrent versions surviving delete-marker creation
  // (#44). Lifecycle rule #1 below expires those noncurrent versions
  // after 30 days so the bucket doesn't accumulate forever.
  cfnBucket.versioningConfiguration = { status: 'Enabled' };

  // Server-side encryption — SSE-S3 default (#44 + #48). Amplify Gen
  // 2's defineStorage enables SSE-S3 out of the box on most regions,
  // but we pin it explicitly here so a future Amplify release that
  // changes the default still leaves us encrypted-at-rest.
  // CFN-side string literal — the `BucketEncryption.S3_MANAGED`
  // enum from aws-cdk-lib/aws-s3 is meant for the L2 `Bucket`
  // construct's `encryption` prop and serialises to the enum name
  // (`"S3_MANAGED"`) when written directly onto the L1
  // `CfnBucket.bucketEncryption`. The CFN service itself only
  // accepts `"AES256"` or `"aws:kms"` here, so pin the literal.
  cfnBucket.bucketEncryption = {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: {
          sseAlgorithm: 'AES256',
        },
      },
    ],
  };

  // CORS rules — same shape on every method so the multipart-
  // resumable-upload pre-signed URLs work for the upload-client +
  // the web app. AllowedHeaders includes the `x-amz-*` set Amplify's
  // S3 SDK sends on uploads.
  cfnBucket.corsConfiguration = {
    corsRules: [
      {
        allowedHeaders: ['*'],
        allowedMethods: [
          HttpMethods.GET,
          HttpMethods.HEAD,
          HttpMethods.PUT,
          HttpMethods.POST,
          HttpMethods.DELETE,
        ],
        allowedOrigins: config.corsOrigins,
        exposedHeaders: ['ETag', 'x-amz-version-id'],
        maxAge: 3000,
      },
    ],
  };

  // Lifecycle: three rules layered onto the bucket via the L1
  // `LifecycleConfiguration.Rules` array. We use L1 rather than
  // `bucket.addLifecycleRule(...)` because `defineStorage()` returns
  // an `IBucket` interface, not a concrete `Bucket`, and the L2
  // helper isn't on the interface. Same end-state in the CFN
  // template either way.
  cfnBucket.lifecycleConfiguration = {
    rules: [
      {
        id: 'recordings-noncurrent-30d',
        status: 'Enabled',
        prefix: 'recordings/',
        noncurrentVersionExpiration: {
          // CFN expects `NoncurrentDays`; the CDK property is
          // `noncurrentDays` which serialises to the right key.
          noncurrentDays: 30,
        },
        expiredObjectDeleteMarker: true,
      },
      {
        id: 'pipeline-temp-7d',
        status: 'Enabled',
        prefix: 'pipeline-temp/',
        expirationInDays: 7,
        abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
      },
      {
        id: 'exports-7d',
        status: 'Enabled',
        prefix: 'exports/',
        expirationInDays: 7,
      },
      {
        // Linguistic diagnostics-trace spill (#749). Oversized
        // LinguisticTrace rows offload their prompt/response blobs here;
        // expire at 90 days to match the LinguisticTrace DynamoDB TTL so
        // the two retention windows stay aligned.
        id: 'diagnostics-90d',
        status: 'Enabled',
        prefix: 'diagnostics/',
        expirationInDays: 90,
        abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
      },
    ],
  };
}
