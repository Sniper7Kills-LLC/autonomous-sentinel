import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * S3 putter for the LinguisticTrace size-guard spill (#749).
 *
 * #744 captured traces with an in-row size guard that DROPPED the two large
 * text fields when a row would exceed the DynamoDB item limit. This wires
 * the actual spill: the oversized fields go to a `diagnostics/` object in
 * the media bucket and the keys are recorded in `overflowKeys`.
 *
 * Returns `undefined` when no bucket is configured so the size guard falls
 * back to dropping the fields (never crashes). The IAM grant
 * (`s3:PutObject` on `<bucket>/diagnostics/*`) is wired in `backend.ts`;
 * granting the data-stack linguistic Lambda this bucket reference is safe —
 * `recordingMutations` (also `resourceGroupName:'data'`) already references
 * the same bucket, so the `data → storage` edge exists and is one-way (no
 * CFN cycle; the original #644 concern was a data↔function cycle, not this).
 */

let cachedClient: S3Client | undefined;

export type DiagnosticsPutObject = (key: string, body: string) => Promise<void>;

export function makeDiagnosticsPutObject(
  bucket: string | undefined,
): DiagnosticsPutObject | undefined {
  if (!bucket) return undefined;
  return async (key, body) => {
    cachedClient ??= new S3Client({});
    await cachedClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: key.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8',
      }),
    );
  };
}
