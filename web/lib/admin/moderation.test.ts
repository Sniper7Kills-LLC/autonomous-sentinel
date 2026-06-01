import { describe, it, expect } from 'vitest';
import {
  excerpt,
  normalizeAbuseReport,
  normalizeComment,
  normalizeMessage,
  sortQueueOldestFirst,
  filterBySource,
  type QueueItem,
} from './moderation';

describe('excerpt', () => {
  it('collapses whitespace and trims', () => {
    expect(excerpt('  hello   world \n there ')).toBe('hello world there');
  });

  it('returns (empty) for nullish / blank input', () => {
    expect(excerpt(null)).toBe('(empty)');
    expect(excerpt('   ')).toBe('(empty)');
  });

  it('clamps long text with an ellipsis', () => {
    const out = excerpt('a'.repeat(200), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('normalizeAbuseReport', () => {
  it('maps reporter, reason, and notes summary', () => {
    const item = normalizeAbuseReport({
      id: 'r1',
      reporterId: 'sub-123',
      targetType: 'MESSAGE',
      targetId: 'm9',
      reason: 'SPAM',
      notes: 'looks like spam',
      status: 'OPEN',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(item.source).toBe('ABUSE_REPORT');
    expect(item.key).toBe('ABUSE_REPORT#r1');
    expect(item.targetId).toBe('r1');
    expect(item.reporter).toBe('sub-123');
    expect(item.reason).toBe('SPAM');
    expect(item.summary).toBe('looks like spam');
    expect(item.href).toBe('/messages/view?id=m9');
  });

  it('falls back to a target summary when notes are blank and resolves no href for non-message targets', () => {
    const item = normalizeAbuseReport({
      id: 'r2',
      reporterId: 'sub-1',
      targetType: 'USER',
      targetId: 'u5',
      reason: 'IMPERSONATION',
      status: 'REVIEWING',
    });
    expect(item.summary).toBe('Report on USER');
    expect(item.href).toBeNull();
  });
});

describe('normalizeComment', () => {
  it('links to the parent message and excerpts the body', () => {
    const item = normalizeComment({
      id: 'c1',
      messageId: 'm3',
      body: 'a rude comment',
      flagged: true,
      createdAt: '2026-02-02T00:00:00.000Z',
    });
    expect(item.source).toBe('COMMENT');
    expect(item.summary).toBe('a rude comment');
    expect(item.reporter).toBeNull();
    expect(item.reason).toBeNull();
    expect(item.href).toBe('/messages/view?id=m3');
  });
});

describe('normalizeMessage', () => {
  it('prefixes sender/receiver headline and links to itself', () => {
    const item = normalizeMessage({
      id: 'm7',
      sender: 'SKYKING',
      receiver: 'ALL',
      body: 'do not answer',
      type: 'SKYKING',
      flaggedForReview: true,
      broadcastTs: '2026-03-03T00:00:00.000Z',
    });
    expect(item.source).toBe('MESSAGE');
    expect(item.summary).toBe('SKYKING → ALL: do not answer');
    expect(item.reason).toBe('SKYKING');
    expect(item.href).toBe('/messages/view?id=m7');
    expect(item.createdAt).toBe('2026-03-03T00:00:00.000Z');
  });

  it('omits the headline when sender/receiver are absent', () => {
    const item = normalizeMessage({ id: 'm8', body: 'lonely body', flaggedForReview: true });
    expect(item.summary).toBe('lonely body');
  });
});

describe('sortQueueOldestFirst', () => {
  it('orders by createdAt ascending, nulls first', () => {
    const items: QueueItem[] = [
      { ...base(), key: 'b', createdAt: '2026-01-03T00:00:00Z' },
      { ...base(), key: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { ...base(), key: 'n', createdAt: null },
    ];
    expect(sortQueueOldestFirst(items).map((i) => i.key)).toEqual(['n', 'a', 'b']);
  });
});

describe('filterBySource', () => {
  const items: QueueItem[] = [
    { ...base(), source: 'COMMENT', key: 'c' },
    { ...base(), source: 'MESSAGE', key: 'm' },
    { ...base(), source: 'ABUSE_REPORT', key: 'r' },
  ];

  it('returns everything for ALL', () => {
    expect(filterBySource(items, 'ALL')).toHaveLength(3);
  });

  it('filters to the chosen source', () => {
    expect(filterBySource(items, 'COMMENT').map((i) => i.key)).toEqual(['c']);
    expect(filterBySource(items, 'ABUSE_REPORT').map((i) => i.key)).toEqual(['r']);
  });
});

function base(): QueueItem {
  return {
    key: 'x',
    source: 'COMMENT',
    targetId: 'x',
    sourceLabel: 'x',
    summary: 'x',
    reporter: null,
    reason: null,
    createdAt: null,
    href: null,
  };
}
