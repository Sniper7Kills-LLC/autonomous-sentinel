import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { attachPipelineQueues } from './pipeline-queues';

/**
 * Synth-shape tests for the pipeline SQS queues + DLQs (#67).
 *
 * Pins the 6-resource fan-out (3 main + 3 DLQ), visibility timeouts
 * per the issue's table, DLQ wiring via `RedrivePolicy`, and
 * SSE-SQS encryption on every queue. Mirrors the
 * `storage-lifecycle.test.ts` Template-from-stack pattern.
 */

function synth(opts: Parameters<typeof attachPipelineQueues>[1] = {}): Template {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  attachPipelineQueues(stack, opts);
  return Template.fromStack(stack);
}

describe('attachPipelineQueues — stage queue inventory (#67)', () => {
  it('creates exactly 6 queues — 3 main + 3 DLQ for preprocess, transcribe, linguistic', () => {
    synth().resourceCountIs('AWS::SQS::Queue', 6);
  });
});

describe('attachPipelineQueues — visibility timeouts (#67)', () => {
  it('sets the preprocess main queue visibility to 6 minutes (360 s) per the issue table', () => {
    synth().hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 360,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('sets the transcribe main queue visibility to 90 minutes (5400 s)', () => {
    synth().hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 5400,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('sets the linguistic main queue visibility to 6 minutes (360 s)', () => {
    // Same 6-min window as preprocess — assertion sweeps both
    // matches via findResources to verify exactly two 360-s queues.
    const t = synth();
    const queues = t.findResources('AWS::SQS::Queue', {
      Properties: Match.objectLike({ VisibilityTimeout: 360 }),
    });
    // 360 s == preprocess + linguistic (DLQs have no
    // VisibilityTimeout set since nothing consumes them).
    const ids = Object.keys(queues);
    expect(ids.length).toBe(2);
  });
});

describe('attachPipelineQueues — DLQs (#67)', () => {
  it('every main queue redrives to a DLQ at maxReceiveCount=3', () => {
    const t = synth();
    // Three RedrivePolicy refs total, one per main queue.
    const mains = t.findResources('AWS::SQS::Queue', {
      Properties: Match.objectLike({
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
      }),
    });
    expect(Object.keys(mains).length).toBe(3);
  });

  it('every DLQ retains messages for 14 days (1209600 s)', () => {
    const t = synth();
    const dlqs = t.findResources('AWS::SQS::Queue', {
      Properties: Match.objectLike({ MessageRetentionPeriod: 1209600 }),
    });
    // DLQs only — the three main queues use 4-day retention.
    expect(Object.keys(dlqs).length).toBe(3);
  });

  it('honours opts.maxReceiveCount when overridden (env-tunable cap)', () => {
    const t = synth({ maxReceiveCount: 7 });
    const mains = t.findResources('AWS::SQS::Queue', {
      Properties: Match.objectLike({
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 7 }),
      }),
    });
    expect(Object.keys(mains).length).toBe(3);
  });
});

describe('attachPipelineQueues — encryption (#67)', () => {
  it('every queue (main + DLQ) uses SSE-SQS managed encryption', () => {
    const t = synth();
    // `QueueEncryption.SQS_MANAGED` serialises to
    // `SqsManagedSseEnabled: true` on the CFN resource (not the
    // `KmsMasterKeyId: 'alias/aws/sqs'` form — that's the
    // AWS-managed-KMS variant, a different CDK enum value).
    // Verify on all 6 queues.
    const encrypted = t.findResources('AWS::SQS::Queue', {
      Properties: Match.objectLike({ SqsManagedSseEnabled: true }),
    });
    expect(Object.keys(encrypted).length).toBe(6);
  });
});
