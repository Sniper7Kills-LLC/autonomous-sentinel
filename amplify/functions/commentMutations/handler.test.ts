import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type CommentMutationsDataClient,
  type CommentRow,
} from './handler';

/**
 * Lambda-resolver tests for Comment custom mutations (#32).
 *
 * Two mutations:
 *   - `createComment` — server-side depth clamp + flatten. Depth is
 *     `min(parent.depth + 1, 3)`; if the caller targets a depth-3
 *     comment, the new comment's `parentCommentId` is rewritten to
 *     the deepest legal ancestor (depth-2) so the thread keeps the
 *     parent-comment chain queryable without exceeding the cap.
 *   - `softDeleteComment` — author or mod/admin. Sets `deletedAt`,
 *     rewrites `body` to `[removed]`, emits `COMMENT_DELETE` audit.
 *     Mirrors the softDeleteMessage / softDeleteRecording shape.
 */

function makeEvent(
  overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> & {
    fieldName?: string;
  } = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  const { fieldName = 'createComment', ...rest } = overrides;
  const base: AppSyncResolverEvent<Record<string, unknown>> = {
    arguments: {},
    identity: {
      sub: 'cog-author-001',
      issuer: 'https://cognito',
      username: 'author',
      claims: {},
      sourceIp: ['203.0.113.1'],
      defaultAuthStrategy: 'ALLOW',
      groups: [],
    },
    source: null,
    request: {
      headers: { 'x-forwarded-for': '203.0.113.1', 'user-agent': 'TestAgent/1.0' },
      domainName: null,
    },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Mutation',
      fieldName,
      variables: {},
    },
    prev: null,
    stash: {},
  };
  return { ...base, ...rest };
}

function makeStubs(opts: { existing?: CommentRow[] } = {}): {
  client: CommentMutationsDataClient;
  getSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
  newId: () => string;
} {
  const rows = new Map<string, CommentRow>();
  for (const r of opts.existing ?? []) rows.set(r.id, r);
  let idCounter = 0;
  const newId = (): string => {
    idCounter += 1;
    return `gen-id-${idCounter}`;
  };

  const getSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: rows.get(input.id) ?? null, errors: undefined }),
  );
  const createSpy = vi.fn((input: Omit<CommentRow, 'id'>) => {
    const id = newId();
    const row: CommentRow = { id, ...input } as CommentRow;
    rows.set(id, row);
    return Promise.resolve({ data: row, errors: undefined });
  });
  const updateSpy = vi.fn((input: Partial<CommentRow> & { id: string }) => {
    const before = rows.get(input.id);
    const merged: CommentRow = { ...(before ?? { id: input.id }), ...input } as CommentRow;
    rows.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  const auditSpy = vi.fn(() => Promise.resolve('audit-id'));
  return {
    client: { models: { Comment: { get: getSpy, create: createSpy, update: updateSpy } } },
    getSpy,
    createSpy,
    updateSpy,
    auditSpy,
    newId,
  };
}

describe('commentMutations — dispatch', () => {
  beforeEach(() => __resetDeps());

  it('rejects an unknown fieldName', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ fieldName: 'somethingElse' });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/fieldName/i);
  });
});

describe('commentMutations — createComment', () => {
  beforeEach(() => __resetDeps());

  it('rejects when caller has no identity sub', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { messageId: 'm-1', body: 'hi' } });
    event.identity = null;
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/identity/i);
  });

  it('rejects when messageId argument is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { body: 'hi' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/messageId/i);
  });

  it('rejects when body is empty', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { messageId: 'm-1', body: '' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/body/i);
  });

  it('top-level comment lands with depth=0 and authorId from identity', async () => {
    const { client, createSpy, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { messageId: 'm-1', body: 'top-level' } });
    await handler(event, {} as Context, () => undefined);

    expect(createSpy).toHaveBeenCalledOnce();
    const input = createSpy.mock.calls[0]?.[0] as CommentRow;
    expect(input.depth).toBe(0);
    expect(input.parentCommentId).toBeUndefined();
    expect(input.authorId).toBe('cog-author-001');
    expect(input.body).toBe('top-level');
  });

  it('reply to depth-0 lands at depth=1 with parentCommentId preserved', async () => {
    const { client, createSpy, auditSpy } = makeStubs({
      existing: [{ id: 'c-0', depth: 0, body: 'parent', messageId: 'm-1', authorId: 'someone' }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'm-1', body: 'reply', parentCommentId: 'c-0' },
    });
    await handler(event, {} as Context, () => undefined);

    const input = createSpy.mock.calls[0]?.[0] as CommentRow;
    expect(input.depth).toBe(1);
    expect(input.parentCommentId).toBe('c-0');
  });

  it('reply to depth-2 lands at depth=3 with parentCommentId preserved', async () => {
    const { client, createSpy, auditSpy } = makeStubs({
      existing: [{ id: 'c-2', depth: 2, body: 'depth-2', messageId: 'm-1', authorId: 'someone' }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'm-1', body: 'reply at 3', parentCommentId: 'c-2' },
    });
    await handler(event, {} as Context, () => undefined);

    const input = createSpy.mock.calls[0]?.[0] as CommentRow;
    expect(input.depth).toBe(3);
    expect(input.parentCommentId).toBe('c-2');
  });

  it('reply to depth-3 flattens — depth stays 3 and parentCommentId rewrites to the depth-3 parent', async () => {
    const { client, createSpy, auditSpy } = makeStubs({
      existing: [
        { id: 'c-3', depth: 3, body: 'already at cap', messageId: 'm-1', authorId: 'someone' },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'm-1', body: 'reply at 4 attempt', parentCommentId: 'c-3' },
    });
    await handler(event, {} as Context, () => undefined);

    const input = createSpy.mock.calls[0]?.[0] as CommentRow;
    // The new comment stays at depth 3 (cap) and points at the
    // existing depth-3 comment as its parent — i.e. attaches as a
    // sibling within the depth-3 layer.
    expect(input.depth).toBe(3);
    expect(input.parentCommentId).toBe('c-3');
  });

  it('rejects when parentCommentId points at a non-existent comment', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'm-1', body: 'x', parentCommentId: 'nope' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/parent/i);
  });

  it('rejects when parentCommentId points at a comment on a different Message', async () => {
    const { client, auditSpy } = makeStubs({
      existing: [{ id: 'c-other-msg', depth: 0, body: 'x', messageId: 'OTHER-MSG', authorId: 's' }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'm-1', body: 'x', parentCommentId: 'c-other-msg' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/message/i);
  });

  it('returns the created comment row', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { messageId: 'm-1', body: 'hi' } });
    const result = (await handler(event, {} as Context, () => undefined)) as CommentRow;
    expect(result.id).toMatch(/^gen-id-/);
    expect(result.body).toBe('hi');
    expect(result.authorId).toBe('cog-author-001');
  });
});

describe('commentMutations — softDeleteComment', () => {
  beforeEach(() => __resetDeps());

  it('author can soft-delete their own comment', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({
      existing: [
        {
          id: 'c-1',
          messageId: 'm-1',
          body: 'sensitive',
          authorId: 'cog-author-001',
          depth: 0,
          deletedAt: null,
        },
      ],
    });
    __setDeps({
      dataClient: client,
      audit: auditSpy,
      now: () => new Date('2026-05-17T00:30:00.000Z'),
    });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'c-1', reason: 'my mistake' },
    });
    await handler(event, {} as Context, () => undefined);

    const patch = updateSpy.mock.calls[0]?.[0] as CommentRow;
    expect(patch.id).toBe('c-1');
    expect(patch.deletedAt).toBe('2026-05-17T00:30:00.000Z');
    expect(patch.body).toBe('[removed]');

    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('COMMENT_DELETE');
    expect(opts.targetType).toBe('Comment');
    expect(opts.targetId).toBe('c-1');
    expect(opts.reason).toBe('my mistake');
  });

  it('moderator can soft-delete any comment', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({
      existing: [
        {
          id: 'c-mod',
          messageId: 'm-1',
          body: 'bad stuff',
          authorId: 'someone-else',
          depth: 0,
          deletedAt: null,
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'c-mod', reason: 'rule-violation' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['moderator'];
    }
    await handler(event, {} as Context, () => undefined);

    expect(updateSpy).toHaveBeenCalledOnce();
  });

  it('admin can soft-delete any comment', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({
      existing: [
        {
          id: 'c-a',
          messageId: 'm-1',
          body: 'x',
          authorId: 'someone',
          depth: 0,
          deletedAt: null,
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'c-a', reason: 'X' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    expect(updateSpy).toHaveBeenCalledOnce();
  });

  it('rejects when caller is neither author nor mod/admin', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({
      existing: [
        {
          id: 'c-x',
          messageId: 'm-1',
          body: 'x',
          authorId: 'someone-else',
          depth: 0,
          deletedAt: null,
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'c-x', reason: 'X' },
    });
    // identity.sub = cog-author-001; authorId is someone-else; groups empty
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/permission/i);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('throws when commentId argument is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ fieldName: 'softDeleteComment', arguments: { reason: 'X' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/commentId/i);
  });

  it('throws when the target Comment does not exist', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'no-such', reason: 'X' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not found/i);
  });

  it('is idempotent on already-deleted comments', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({
      existing: [
        {
          id: 'c-d',
          messageId: 'm-1',
          body: '[removed]',
          authorId: 'cog-author-001',
          depth: 0,
          deletedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'c-d', reason: 'second-try' },
    });
    const result = (await handler(event, {} as Context, () => undefined)) as CommentRow;
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(result.deletedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('normalises empty reason as null on the audit entry', async () => {
    const { client, auditSpy } = makeStubs({
      existing: [
        {
          id: 'c-n',
          messageId: 'm-1',
          body: 'x',
          authorId: 'cog-author-001',
          depth: 0,
          deletedAt: null,
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'softDeleteComment',
      arguments: { commentId: 'c-n', reason: '' },
    });
    await handler(event, {} as Context, () => undefined);
    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.reason).toBeNull();
  });
});
