'use client';

import { getUrl } from 'aws-amplify/storage';
import { configureAmplifyOnce } from '@/lib/amplifyClient';

/**
 * Resolve an S3 key under the `autonomousSentinelMedia` bucket into a
 * short-lived signed URL. Used by the audio player + sidecar fetchers
 * (waveform peaks JSON, word-timestamps JSON).
 *
 * Guest access is granted on `recordings/web/*` via `amplify/storage`,
 * so guest visitors can play + scrub broadcasts without signing in.
 */
export async function getRecordingAssetUrl(key: string): Promise<string> {
  configureAmplifyOnce();
  const result = await getUrl({ path: key });
  return result.url.toString();
}
