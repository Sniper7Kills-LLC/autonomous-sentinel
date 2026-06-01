import { describe, it, expect } from 'vitest';
import {
  buildCommentTree,
  countComments,
  toDisplayComment,
  MAX_DISPLAY_DEPTH,
  type DisplayComment,
} from './query';

function comment(partial: Partial<DisplayComment>): DisplayComment {
  return {
    id: 'c',
    messageId: 'm',
    parentCommentId: null,
    depth: 0,
    body: 'hi',
    authorId: 'a',
    flagged: false,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
    ...partial,
  };
}

describe('toDisplayComment', () => {
  it('defaults nullable fields', () => {
    const d = toDisplayComment({ id: 'c1', messageId: 'm1' });
    expect(d.parentCommentId).toBeNull();
    expect(d.depth).toBe(0);
    expect(d.body).toBe('');
    expect(d.flagged).toBe(false);
    expect(d.deletedAt).toBeNull();
  });

  it('copies populated fields', () => {
    const d = toDisplayComment({
      id: 'c1',
      messageId: 'm1',
      parentCommentId: 'p1',
      depth: 2,
      body: 'text',
      authorId: 'u1',
      flagged: true,
      deletedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(d.parentCommentId).toBe('p1');
    expect(d.depth).toBe(2);
    expect(d.flagged).toBe(true);
  });
});

describe('buildCommentTree', () => {
  it('returns an empty tree for no comments', () => {
    expect(buildCommentTree([])).toEqual([]);
  });

  it('nests children under parents up to 3 levels', () => {
    const tree = buildCommentTree([
      comment({ id: 'a', createdAt: '2026-01-01T00:00:01Z' }),
      comment({ id: 'b', parentCommentId: 'a', createdAt: '2026-01-01T00:00:02Z' }),
      comment({ id: 'c', parentCommentId: 'b', createdAt: '2026-01-01T00:00:03Z' }),
    ]);
    expect(tree).toHaveLength(1);
    const a = tree[0]!;
    expect(a.id).toBe('a');
    expect(a.displayDepth).toBe(0);
    const b = a.children[0]!;
    expect(b.id).toBe('b');
    expect(b.displayDepth).toBe(1);
    const c = b.children[0]!;
    expect(c.id).toBe('c');
    expect(c.displayDepth).toBe(MAX_DISPLAY_DEPTH);
  });

  it('flattens a 4th-level reply into the deepest tier as a sibling', () => {
    // a(0) → b(1) → c(2) → d(should flatten to depth 2, sibling of c
    // under b)
    const tree = buildCommentTree([
      comment({ id: 'a', createdAt: '2026-01-01T00:00:01Z' }),
      comment({ id: 'b', parentCommentId: 'a', createdAt: '2026-01-01T00:00:02Z' }),
      comment({ id: 'c', parentCommentId: 'b', createdAt: '2026-01-01T00:00:03Z' }),
      comment({ id: 'd', parentCommentId: 'c', createdAt: '2026-01-01T00:00:04Z' }),
    ]);
    const tierB = tree[0]!.children[0]!; // b at depth 1
    const tier2 = tierB.children; // depth-2 layer under b
    expect(tier2.map((n) => n.id).sort()).toEqual(['c', 'd']);
    for (const n of tier2) {
      expect(n.displayDepth).toBe(MAX_DISPLAY_DEPTH);
      // The flattened node carries no further nesting.
      if (n.id === 'd') expect(n.children).toEqual([]);
    }
  });

  it('flattens a chain even deeper than 4 levels into the deepest tier', () => {
    const tree = buildCommentTree([
      comment({ id: 'a', createdAt: '2026-01-01T00:00:01Z' }),
      comment({ id: 'b', parentCommentId: 'a', createdAt: '2026-01-01T00:00:02Z' }),
      comment({ id: 'c', parentCommentId: 'b', createdAt: '2026-01-01T00:00:03Z' }),
      comment({ id: 'd', parentCommentId: 'c', createdAt: '2026-01-01T00:00:04Z' }),
      comment({ id: 'e', parentCommentId: 'd', createdAt: '2026-01-01T00:00:05Z' }),
    ]);
    // No node anywhere may exceed MAX_DISPLAY_DEPTH.
    const walk = (nodes: typeof tree): number[] =>
      nodes.flatMap((n) => [n.displayDepth, ...walk(n.children)]);
    expect(Math.max(...walk(tree))).toBe(MAX_DISPLAY_DEPTH);
  });

  it('promotes orphans (missing parent) to top level', () => {
    const tree = buildCommentTree([
      comment({ id: 'x', parentCommentId: 'gone', createdAt: '2026-01-01T00:00:01Z' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('x');
    expect(tree[0]!.displayDepth).toBe(0);
  });

  it('orders siblings oldest-first regardless of input order', () => {
    const tree = buildCommentTree([
      comment({ id: 'late', createdAt: '2026-01-01T00:05:00Z' }),
      comment({ id: 'early', createdAt: '2026-01-01T00:01:00Z' }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['early', 'late']);
  });
});

describe('countComments', () => {
  it('counts all nested nodes', () => {
    const tree = buildCommentTree([
      comment({ id: 'a' }),
      comment({ id: 'b', parentCommentId: 'a' }),
      comment({ id: 'c', parentCommentId: 'b' }),
      comment({ id: 'd', parentCommentId: 'c' }),
    ]);
    expect(countComments(tree)).toBe(4);
  });
});
