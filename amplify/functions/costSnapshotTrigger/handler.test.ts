import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import { handler, __setSqsClient } from './handler';

const sqsMock = mockClient(SQSClient);

const event = {} as AppSyncResolverEvent<Record<string, never>>;
const context = {} as Context;
const cb = () => undefined;

describe('costSnapshotTrigger handler (#644)', () => {
  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm-1' });
    process.env.COST_SNAPSHOT_QUEUE_URL =
      'https://sqs.us-east-1.amazonaws.com/123/cost-snapshot-queue';
    // Inject the mocked client so the cached singleton is bypassed.
    __setSqsClient(new SQSClient({}));
  });

  afterEach(() => {
    __setSqsClient(undefined);
    delete process.env.COST_SNAPSHOT_QUEUE_URL;
  });

  it('sends exactly one SQS message to the cost-snapshot queue and returns queued', async () => {
    const out = await handler(event, context, cb);

    expect(out).toEqual({ status: 'queued' });
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.QueueUrl).toBe(
      'https://sqs.us-east-1.amazonaws.com/123/cost-snapshot-queue',
    );
    expect(typeof calls[0]!.args[0].input.MessageBody).toBe('string');
  });

  it('throws when the queue URL env var is missing', async () => {
    delete process.env.COST_SNAPSHOT_QUEUE_URL;
    await expect(handler(event, context, cb)).rejects.toThrow('COST_SNAPSHOT_QUEUE_URL');
  });
});
