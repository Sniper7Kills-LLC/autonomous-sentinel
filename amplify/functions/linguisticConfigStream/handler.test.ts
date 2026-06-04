import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  __resetDeps,
  __setDeps,
  type ConfigStreamDataClient,
  handler,
  processConfigChange,
} from './handler';
import type { ParsedConfigChange } from './parse';
import type { ReprocessMessage } from '../linguistic/reprocess';

const sqsMock = mockClient(SQSClient);

interface RecordingRow {
  id: string;
  transcriptionFailed?: boolean | null;
  deletedAt?: string | null;
  linguisticAttempts?: unknown;
}

/**
 * Build a data-client + sender stub. `pages` are returned by successive
 * Recording.list calls (each page minus the last carries a nextToken).
 */
function makeStub(pages: RecordingRow[][] = []) {
  const auditCreate = vi.fn().mockResolvedValue({ data: { id: 'audit-1' }, errors: null });
  let call = 0;
  const list = vi.fn().mockImplementation(() => {
    const page = pages[call] ?? [];
    const hasNext = call < pages.length - 1;
    call += 1;
    return Promise.resolve({ data: page, nextToken: hasNext ? `tok-${call}` : null, errors: null });
  });
  const sent: ReprocessMessage[] = [];
  const sendReprocess = vi.fn((msgs: ReprocessMessage[]) => {
    sent.push(...msgs);
    return Promise.resolve();
  });
  const client: ConfigStreamDataClient = {
    models: {
      AuditLog: { create: auditCreate as never },
      Recording: { list: list as never },
    },
  };
  return { client, auditCreate, list, sendReprocess, sent };
}

const NOW = () => new Date('2026-05-29T12:00:00Z');

afterEach(() => {
  __resetDeps();
  sqsMock.reset();
  delete process.env.REPROCESS_QUEUE_URL;
});

function update(over: Partial<ParsedConfigChange> = {}): ParsedConfigChange {
  return {
    key: 'CONFIDENCE_THRESHOLD_SKYKING',
    actorId: 'admin-1',
    before: { value: 0.8 },
    after: { value: 0.9 },
    isUpdate: true,
    isPromptVersionBump: false,
    newPromptVersion: null,
    ...over,
  };
}

describe('processConfigChange — audit on every update (#481a)', () => {
  it('writes a LINGUISTIC_CONFIG_UPDATE audit row attributed to the actor', async () => {
    const { client, auditCreate, list, sendReprocess } = makeStub();
    __setDeps({ dataClient: client, sendReprocess, now: NOW, reprocessQueueUrl: 'q' });

    await processConfigChange(update(), {});

    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
      action: 'LINGUISTIC_CONFIG_UPDATE',
      targetType: 'LinguisticConfig',
      targetId: 'CONFIDENCE_THRESHOLD_SKYKING',
      actorId: 'admin-1',
    });
    // Diff captured the value change.
    const row = auditCreate.mock.calls[0]?.[0] as { diff: string };
    const diff = JSON.parse(row.diff) as Record<string, unknown>;
    expect(diff).toMatchObject({ value: { before: 0.8, after: 0.9 } });
    // No reprocess for a non-bump update.
    expect(list).not.toHaveBeenCalled();
    expect(sendReprocess).not.toHaveBeenCalled();
  });

  it('records a system entry (no actorId) when there is no actor', async () => {
    const { client, auditCreate, sendReprocess } = makeStub();
    __setDeps({ dataClient: client, sendReprocess, now: NOW, reprocessQueueUrl: 'q' });
    await processConfigChange(update({ actorId: null }), {});
    // actorId is OMITTED (not null) for system entries — a NULL value would
    // break the i('actorId') sparse GSI key (#718).
    expect(auditCreate.mock.calls[0]?.[0]).not.toHaveProperty('actorId');
  });
});

describe('processConfigChange — reprocess on prompt-version bump (#481b)', () => {
  const bump = () =>
    update({
      key: 'SKYKING_PROMPT_VERSION',
      before: { promptVersion: 2 },
      after: { promptVersion: 3 },
      isPromptVersionBump: true,
      newPromptVersion: 3,
    });

  it('enqueues only failed recordings, tagged with the reason + new version', async () => {
    const { client, auditCreate, list, sendReprocess, sent } = makeStub([
      [
        { id: 'rec-failed', transcriptionFailed: true, linguisticAttempts: [] },
        // A successful recording must never be re-run.
        {
          id: 'rec-ok',
          transcriptionFailed: true,
          linguisticAttempts: [{ provider: 'bedrock', success: true }],
        },
      ],
    ]);
    __setDeps({ dataClient: client, sendReprocess, now: NOW, reprocessQueueUrl: 'q' });

    const out = await processConfigChange(bump(), {});

    // Two audit rows: the update + the bump.
    const actions = auditCreate.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('LINGUISTIC_CONFIG_UPDATE');
    expect(actions).toContain('PROMPT_VERSION_BUMP');
    expect(list).toHaveBeenCalled();
    expect(sent).toEqual([
      {
        recordingId: 'rec-failed',
        reason: 'prompt-version-bump',
        promptVersion: 3,
        enqueuedAt: '2026-05-29T12:00:00.000Z',
      },
    ]);
    expect(out.enqueued).toBe(1);
  });

  it('paginates the Recording scan via nextToken', async () => {
    const { client, list, sendReprocess, sent } = makeStub([
      [{ id: 'a', transcriptionFailed: true, linguisticAttempts: [] }],
      [{ id: 'b', transcriptionFailed: true, linguisticAttempts: [] }],
    ]);
    __setDeps({ dataClient: client, sendReprocess, now: NOW, reprocessQueueUrl: 'q' });

    await processConfigChange(bump(), {});

    expect(list).toHaveBeenCalledTimes(2);
    expect(sent.map((m) => m.recordingId)).toEqual(['a', 'b']);
  });

  it('does not send when no failed recordings match', async () => {
    const { client, sendReprocess } = makeStub([[]]);
    __setDeps({ dataClient: client, sendReprocess, now: NOW, reprocessQueueUrl: 'q' });
    const out = await processConfigChange(bump(), {});
    expect(sendReprocess).not.toHaveBeenCalled();
    expect(out.enqueued).toBe(0);
  });

  it('throws when there is work to send but no queue URL is configured', async () => {
    // No injected sender and no REPROCESS_QUEUE_URL — the production
    // send path must fail loud rather than silently drop the work.
    const { client } = makeStub([
      [{ id: 'rec', transcriptionFailed: true, linguisticAttempts: [] }],
    ]);
    __setDeps({ dataClient: client, now: NOW });
    await expect(processConfigChange(bump(), {})).rejects.toThrow(/REPROCESS_QUEUE_URL/);
  });

  it('splits the production SQS send into batches of 10 (API cap)', async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({});
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `rec-${i}`,
      transcriptionFailed: true,
      linguisticAttempts: [],
    }));
    const { client } = makeStub([rows]);
    // No injected sender → exercises defaultSendReprocess + the real
    // (mocked) SQS client.
    __setDeps({ dataClient: client, now: NOW, reprocessQueueUrl: 'https://sqs/q' });

    const out = await processConfigChange(bump(), {});

    expect(out.enqueued).toBe(12);
    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0].input.Entries).toHaveLength(10);
    expect(calls[1]?.args[0].input.Entries).toHaveLength(2);
  });
});

describe('handler — DynamoDB stream entry point', () => {
  function streamEvent(
    records: { eventName: string; oldImage?: object; newImage?: object }[],
  ): DynamoDBStreamEvent {
    return {
      Records: records.map((r) => ({
        eventName: r.eventName as 'INSERT' | 'MODIFY' | 'REMOVE',
        dynamodb: {
          OldImage: r.oldImage ? marshall(r.oldImage) : undefined,
          NewImage: r.newImage ? marshall(r.newImage) : undefined,
        },
      })) as DynamoDBStreamEvent['Records'],
    };
  }

  const ctx = {} as never;
  const cb = () => undefined;

  it('unmarshals an INSERT (no OldImage) and audits it', async () => {
    const { client, auditCreate } = makeStub();
    __setDeps({ dataClient: client, now: NOW, reprocessQueueUrl: 'q' });
    await handler(
      streamEvent([{ eventName: 'INSERT', newImage: { key: 'SKYKING_RULES', value: { a: 1 } } }]),
      ctx,
      cb,
    );
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({
      action: 'LINGUISTIC_CONFIG_UPDATE',
      targetId: 'SKYKING_RULES',
    });
  });

  it('unmarshals a REMOVE (no NewImage) without throwing', async () => {
    const { client, auditCreate } = makeStub();
    __setDeps({ dataClient: client, now: NOW, reprocessQueueUrl: 'q' });
    await handler(
      streamEvent([{ eventName: 'REMOVE', oldImage: { key: 'SKYKING_RULES', value: { a: 1 } } }]),
      ctx,
      cb,
    );
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({ targetId: 'SKYKING_RULES' });
  });

  it('skips a record that carries no key on either image', async () => {
    const { client, auditCreate } = makeStub();
    __setDeps({ dataClient: client, now: NOW, reprocessQueueUrl: 'q' });
    await handler(streamEvent([{ eventName: 'MODIFY', newImage: { value: 1 } }]), ctx, cb);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
