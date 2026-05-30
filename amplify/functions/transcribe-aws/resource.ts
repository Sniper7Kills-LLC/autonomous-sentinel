import { defineFunction } from '@aws-amplify/backend';

/**
 * Amazon Transcribe backend Lambda — backend (c) (#585, epic #582).
 *
 * Invoked with a single dispatch message `{recordingId, audioKey,
 * enqueuedAt}` (Event invocation from the #582b dispatcher once that
 * lands). Ensures the callsign custom vocabulary, then fires
 * `StartTranscriptionJob` and returns — it does NOT wait for the job
 * (the async finalizer Lambda handles completion).
 *
 * NOT yet wired to the transcribe SQS queue: the #582b dispatcher
 * owns routing recordings to the chosen backend. This Lambda ships
 * deployable-but-unsubscribed; `backend.ts` documents that.
 *
 * Short timeout: the work is GetVocabulary/CreateVocabulary +
 * StartTranscriptionJob — all fast control-plane calls. 30 s covers
 * cold start + a vocab create round-trip with headroom.
 *
 * IAM (in `backend.ts`): transcribe StartTranscriptionJob /
 * GetTranscriptionJob / CreateVocabulary / GetVocabulary; DDB Scan on
 * the Callsign table. Because we call `StartTranscriptionJob` WITHOUT
 * a `DataAccessRoleArn`, Amazon Transcribe reads the input
 * `MediaFileUri` and writes the `OutputBucketName` object using THIS
 * Lambda's role credentials — so the role also needs S3 GetObject on
 * the audio prefixes + PutObject on `pipeline-temp/*`.
 */
export const transcribeAws = defineFunction({
  name: 'transcribe-aws',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
});
