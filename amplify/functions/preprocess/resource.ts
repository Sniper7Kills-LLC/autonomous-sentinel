import { defineFunction } from '@aws-amplify/backend';

/**
 * Pre-process Lambda (#433 stage 2).
 *
 * Triggered by SQS messages on the preprocess queue.
 *
 * v1 work per invoke: S3 HEAD + CopyObject + Amplify Data update +
 * SQS SendMessage — all fast network calls, expected ~3-5 s.
 *
 * Handler timeout is 60s (still 12× expected work — covers cold
 * start + transient AWS latency). Paired with the 6-minute SQS
 * visibility timeout in `amplify/pipeline-queues.ts` this gives the
 * AWS-recommended 6× ratio (visibility = 6× handler timeout) so a
 * stuck handler is fully timed out + cleaned up before SQS releases
 * the message back for retry.
 *
 * When ffmpeg transcoding lands (#433 follow-up), bump this back up
 * + adjust the queue visibility accordingly.
 */
export const preprocess = defineFunction({
  name: 'preprocess',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 1024,
});
