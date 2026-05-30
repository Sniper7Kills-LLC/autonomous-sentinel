import { defineFunction } from '@aws-amplify/backend';

/**
 * Amazon Transcribe async finalizer Lambda (#585, epic #582).
 *
 * EventBridge-triggered on `aws.transcribe` "Transcribe Job State
 * Change" (COMPLETED + FAILED). Recovers the recordingId from the job
 * name, reads the output JSON from `pipeline-temp/*`, projects it via
 * `parseTranscribeResult`, and publishes the canonical transcript /
 * failure message to the linguistic SQS queue (same contract the
 * Whisper container uses).
 *
 * EventBridge rule + IAM wired in `backend.ts`:
 *   - S3 GetObject on `pipeline-temp/*` (read the job output).
 *   - SQS SendMessage on the linguistic queue.
 *
 * Short timeout: one S3 GetObject + one SQS SendMessage. 30 s covers
 * cold start + a large output JSON read.
 */
export const transcribeAwsFinalizer = defineFunction({
  name: 'transcribe-aws-finalizer',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
});
