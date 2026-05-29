import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDeps,
  __setDeps,
  type ConfigStreamDataClient,
  processConfigChange,
} from './handler';
import type { ParsedConfigChange } from './parse';
import type { ReprocessMessage } from '../linguistic/reprocess';

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

afterEach(() => __resetDeps());

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

  it('records actorId null as a system entry', async () => {
    const { client, auditCreate, sendReprocess } = makeStub();
    __setDeps({ dataClient: client, sendReprocess, now: NOW, reprocessQueueUrl: 'q' });
    await processConfigChange(update({ actorId: null }), {});
    expect(auditCreate.mock.calls[0]?.[0]).toMatchObject({ actorId: null });
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
});
