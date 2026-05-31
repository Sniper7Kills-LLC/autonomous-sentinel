import { defineFunction } from '@aws-amplify/backend';

/**
 * Transcribe-dispatch Lambda (#587, epic #582 slice 2).
 *
 * Sole consumer of the transcribe SQS queue. Resolves the active
 * transcribe backend per message (`selector.ts`) and async (Event)
 * Lambda-invokes that backend with the message body. Replaces the old
 * direct `whisperFn.addEventSource(transcribe queue)` subscription so
 * the whisper container + the amazon-transcribe backend are now
 * Event-invoked by ARN instead of queue-subscribed.
 *
 * Env (wired in `backend.ts`): one `*_FN_ARN` per backend
 * (`BACKEND_ENV_VAR` map) carrying each backend Lambda's ARN, plus
 * `DEFAULT_TRANSCRIBE_BACKEND` (the env-wide admin default — kept
 * `whisper-local` so behaviour is unchanged). IAM: `lambda:InvokeFunction`
 * on the backend ARNs.
 *
 * Fast: the handler resolves a backend + fires one async invoke and
 * returns. 30 s covers cold start + the InvokeCommand round-trip with
 * headroom (no transcription work happens here).
 */
export const transcribeDispatch = defineFunction({
  name: 'transcribe-dispatch',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  // Assign to the `data` resource group so the dispatcher Lambda lands
  // in the Amplify Data nested stack rather than the shared `function`
  // stack. The shared `function` stack already sits in a triangle with
  // `data` and `TranscribeAwsStack` (data resolvers ↔ functions ↔ the
  // Transcribe backend's Callsign-table + EventBridge edges); routing
  // the dispatcher's backend-invoke + transcribe-queue-consume edges
  // through `data` instead keeps the nested-stack graph acyclic
  // (`CloudformationStackCircularDependencyError` otherwise — verified
  // via `ampx sandbox --once`). Same pattern as `linguistic`,
  // `commentMutations`, etc. which are also `resourceGroupName: 'data'`.
  resourceGroupName: 'data',
});
