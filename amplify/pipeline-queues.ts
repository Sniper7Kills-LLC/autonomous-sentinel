import { Duration, type Stack } from 'aws-cdk-lib';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';

/**
 * Pipeline SQS queues + DLQs that connect each stage of the SDR
 * recording → published-Message pipeline (#67).
 *
 * Three Standard SQS queues, one per stage. Standard (not FIFO)
 * because per-recording ordering doesn't matter — every Recording is
 * independent — and Standard's higher throughput + at-least-once
 * delivery is the better fit. Each main queue has a paired DLQ with
 * `maxReceiveCount = 3`, 14-day retention, so admin reprocess (later)
 * has a stable inspection surface.
 *
 * Visibility timeouts target ~6× the consumer Lambda's expected
 * execution time per AWS best practice, so a slow run doesn't
 * collide with its retry. The numbers below assume:
 *   - preprocess: ≤ 1 min (silence trim + VAD + Opus transcode on
 *     small audio clips) → 6 min visibility.
 *   - transcribe: highly variable, depends on backend (OpenAI
 *     Whisper API ~30 s / Amazon Transcribe ~60 s / self-hosted
 *     Whisper container ~5 min for medium-model cold + long clip)
 *     → 90 min visibility comfortably covers worst case.
 *   - linguistic: ≤ 1 min (rules + regex + optional Bedrock
 *     fallback) → 6 min visibility.
 *
 * Encryption: SQS-managed SSE on every queue. AWS-managed key, no
 * KMS cost; switch to a customer-managed key later if compliance
 * demands it.
 *
 * **Out of scope for this module**:
 *   - S3 ObjectCreated event source on the media bucket → preprocess
 *     queue. Lands with the pre-process Lambda PR (#49-#52) because
 *     it's the consumer that materialises the chain.
 *   - SqsEventSource wiring on each consumer Lambda. Lands with the
 *     respective Lambda PR; the queue ARN is exposed below so each
 *     consumer can grant itself receive perms.
 *   - CloudWatch alarms on DLQ depth + SNS notifications. Tracked
 *     as a follow-up — needs SNS topic + admin email config that
 *     phase 9 ops + alerts will cover (#214 area).
 *   - Admin reprocess Lambda that drains DLQ back to main. Tracked
 *     as a separate phase-3 follow-up; admin UI consumer is phase 4.
 *
 * `attachPipelineQueues` returns the queue + DLQ pairs so callers
 * (backend.ts, later consumer-Lambda wiring) can grant + subscribe.
 */

export interface PipelineQueuePair {
  main: Queue;
  dlq: Queue;
}

export interface PipelineQueues {
  preprocess: PipelineQueuePair;
  transcribe: PipelineQueuePair;
  linguistic: PipelineQueuePair;
}

export interface PipelineQueueOpts {
  /**
   * Maximum number of failed receives before a message moves to the
   * DLQ. Defaults to 3 per CLAUDE.md "stuck messages land in DLQs
   * for admin reprocess".
   */
  maxReceiveCount?: number;
  /**
   * DLQ retention. Defaults to 14 days — covers a standard ops-
   * weekend triage window without paying for indefinite storage.
   */
  dlqRetentionDays?: number;
}

const DEFAULT_OPTS: Required<PipelineQueueOpts> = {
  maxReceiveCount: 3,
  dlqRetentionDays: 14,
};

interface StageSpec {
  id: string;
  visibilityMinutes: number;
}

const STAGE_SPECS: Record<keyof PipelineQueues, StageSpec> = {
  preprocess: { id: 'Preprocess', visibilityMinutes: 6 },
  transcribe: { id: 'Transcribe', visibilityMinutes: 90 },
  linguistic: { id: 'Linguistic', visibilityMinutes: 6 },
};

function pair(stack: Stack, spec: StageSpec, opts: Required<PipelineQueueOpts>): PipelineQueuePair {
  const dlq = new Queue(stack, `${spec.id}DeadLetterQueue`, {
    retentionPeriod: Duration.days(opts.dlqRetentionDays),
    encryption: QueueEncryption.SQS_MANAGED,
  });
  const main = new Queue(stack, `${spec.id}Queue`, {
    visibilityTimeout: Duration.minutes(spec.visibilityMinutes),
    retentionPeriod: Duration.days(4),
    encryption: QueueEncryption.SQS_MANAGED,
    deadLetterQueue: { queue: dlq, maxReceiveCount: opts.maxReceiveCount },
  });
  return { main, dlq };
}

export function attachPipelineQueues(stack: Stack, opts: PipelineQueueOpts = {}): PipelineQueues {
  const resolved: Required<PipelineQueueOpts> = { ...DEFAULT_OPTS, ...opts };
  return {
    preprocess: pair(stack, STAGE_SPECS.preprocess, resolved),
    transcribe: pair(stack, STAGE_SPECS.transcribe, resolved),
    linguistic: pair(stack, STAGE_SPECS.linguistic, resolved),
  };
}
