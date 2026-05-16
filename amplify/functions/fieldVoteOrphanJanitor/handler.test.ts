import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ScheduledEvent, Context } from 'aws-lambda';
import { handler, __setDeps, __resetDeps, type JanitorDeps, type FieldVoteRow } from './handler';

/**
 * Tests for the FieldVote orphan-vote janitor (#270).
 *
 * Strategy:
 *   1. Page through FieldVote rows (`scanFieldVotes`).
 *   2. Per page, batch-fetch the referenced Message rows
 *      (`batchGetMessages`). Identify messageIds that don't resolve.
 *   3. Delete FieldVote rows pointing at missing messageIds
 *      (`deleteFieldVotes`).
 *   4. Emit one `FIELDVOTE_ORPHAN_SWEEP` audit entry per sweep with
 *      the total count.
 */

function makeDeps(
  opts: {
    pages?: { items: FieldVoteRow[]; nextToken?: string }[];
    messagesPresent?: Set<string>;
  } = {},
): JanitorDeps & {
  scanSpy: ReturnType<typeof vi.fn>;
  batchGetSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const pages = opts.pages ?? [{ items: [] }];
  let pageIdx = 0;
  const scanSpy = vi.fn(() => {
    const page = pages[pageIdx] ?? { items: [] };
    pageIdx += 1;
    return Promise.resolve(page);
  });
  const present = opts.messagesPresent ?? new Set<string>();
  const batchGetSpy = vi.fn((input: { messageIds: string[] }) =>
    Promise.resolve({ presentIds: new Set(input.messageIds.filter((id) => present.has(id))) }),
  );
  const deleteSpy = vi.fn(() => Promise.resolve());
  const auditSpy = vi.fn(() => Promise.resolve('audit-id-1'));
  return {
    scanSpy,
    batchGetSpy,
    deleteSpy,
    auditSpy,
    scanFieldVotes: scanSpy,
    batchGetMessages: batchGetSpy,
    deleteFieldVotes: deleteSpy,
    audit: auditSpy,
    now: () => new Date('2026-05-16T23:30:00.000Z'),
  };
}

const event = {} as ScheduledEvent;
const context = {} as Context;

describe('fieldVoteOrphanJanitor', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('no-op when FieldVote is empty — no deletes, single audit with count 0', async () => {
    const deps = makeDeps({ pages: [{ items: [] }] });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.scanSpy).toHaveBeenCalledOnce();
    expect(deps.deleteSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).toHaveBeenCalledOnce();
    const [, opts] = deps.auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('FIELDVOTE_ORPHAN_SWEEP');
    const after = opts.after as Record<string, unknown>;
    expect(after.orphanCount).toBe(0);
  });

  it('keeps rows whose messageId resolves to an existing Message', async () => {
    const deps = makeDeps({
      pages: [
        {
          items: [
            { fieldKey: 'msg-1#SENDER#voter-a', messageId: 'msg-1' },
            { fieldKey: 'msg-2#SENDER#voter-b', messageId: 'msg-2' },
          ],
        },
      ],
      messagesPresent: new Set(['msg-1', 'msg-2']),
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.deleteSpy).not.toHaveBeenCalled();
    const [, opts] = deps.auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect((opts.after as { orphanCount: number }).orphanCount).toBe(0);
  });

  it('deletes rows whose messageId no longer resolves', async () => {
    const deps = makeDeps({
      pages: [
        {
          items: [
            { fieldKey: 'msg-gone#SENDER#voter-a', messageId: 'msg-gone' },
            { fieldKey: 'msg-1#SENDER#voter-b', messageId: 'msg-1' },
            { fieldKey: 'msg-also-gone#TYPE#voter-c', messageId: 'msg-also-gone' },
          ],
        },
      ],
      messagesPresent: new Set(['msg-1']),
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.deleteSpy).toHaveBeenCalledOnce();
    const deleted = deps.deleteSpy.mock.calls[0]?.[0] as { fieldKeys: string[] };
    expect(deleted.fieldKeys).toEqual(
      expect.arrayContaining(['msg-gone#SENDER#voter-a', 'msg-also-gone#TYPE#voter-c']),
    );
    expect(deleted.fieldKeys).not.toContain('msg-1#SENDER#voter-b');
  });

  it('chunks deletes into BatchWriteItem-sized batches (default 25)', async () => {
    // 40 orphans in one Scan page → 2 delete calls (25 + 15).
    const items: FieldVoteRow[] = Array.from({ length: 40 }, (_, i) => ({
      fieldKey: `gone-${i}#SENDER#voter`,
      messageId: `gone-${i}`,
    }));
    const deps = makeDeps({
      pages: [{ items }],
      messagesPresent: new Set(), // every messageId is missing
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.deleteSpy).toHaveBeenCalledTimes(2);
    const first = deps.deleteSpy.mock.calls[0]?.[0] as { fieldKeys: string[] };
    const second = deps.deleteSpy.mock.calls[1]?.[0] as { fieldKeys: string[] };
    expect(first.fieldKeys).toHaveLength(25);
    expect(second.fieldKeys).toHaveLength(15);
  });

  it('paginates through multiple Scan pages until exhaustion', async () => {
    const deps = makeDeps({
      pages: [
        {
          items: [{ fieldKey: 'a#SENDER#v', messageId: 'a' }],
          nextToken: 'cursor-1',
        },
        {
          items: [{ fieldKey: 'b#SENDER#v', messageId: 'b' }],
          nextToken: undefined,
        },
      ],
      messagesPresent: new Set(['a', 'b']),
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.scanSpy).toHaveBeenCalledTimes(2);
    expect(deps.scanSpy.mock.calls[0]?.[0]).toMatchObject({ nextToken: undefined });
    expect(deps.scanSpy.mock.calls[1]?.[0]).toMatchObject({ nextToken: 'cursor-1' });
  });

  it('emits a FIELDVOTE_ORPHAN_SWEEP audit with orphanCount + first/last orphan ids', async () => {
    const deps = makeDeps({
      pages: [
        {
          items: [
            { fieldKey: 'msg-z#SENDER#v', messageId: 'msg-z' },
            { fieldKey: 'msg-a#SENDER#v', messageId: 'msg-a' },
            { fieldKey: 'msg-m#SENDER#v', messageId: 'msg-m' },
          ],
        },
      ],
      messagesPresent: new Set(),
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    const [, opts] = deps.auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('FIELDVOTE_ORPHAN_SWEEP');
    expect(opts.targetType).toBe('FieldVote');
    const after = opts.after as Record<string, unknown>;
    expect(after.orphanCount).toBe(3);
    expect(after.firstMessageId).toBe('msg-z');
    expect(after.lastMessageId).toBe('msg-m');
  });

  it('survives a single batch-get failure (logs + continues to next page)', async () => {
    const deps = makeDeps({
      pages: [
        { items: [{ fieldKey: 'a#SENDER#v', messageId: 'a' }], nextToken: 'pg-1' },
        { items: [{ fieldKey: 'b#SENDER#v', messageId: 'b' }] },
      ],
      messagesPresent: new Set(['a', 'b']),
    });
    // First call throws; second succeeds.
    deps.batchGetSpy
      .mockImplementationOnce(() => Promise.reject(new Error('DDB throttled')))
      .mockImplementationOnce(() => Promise.resolve({ presentIds: new Set(['b']) }));
    __setDeps(deps);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handler(event, context, () => undefined);

    expect(deps.batchGetSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects an event when no deps are injected (production wiring required)', async () => {
    __resetDeps();
    await expect(handler(event, context, () => undefined)).rejects.toThrow();
  });
});
