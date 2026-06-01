import { describe, it, expect } from 'vitest';
import {
  buildAuditFilter,
  csvEscape,
  toCsv,
  jsonDiff,
  splitDiffPayload,
  actorLabel,
  toAuditRow,
  type AuditRow,
} from './audit';

function row(p: Partial<AuditRow>): AuditRow {
  return {
    id: 'a1',
    actorId: 'sub-123',
    action: 'MESSAGE_DELETE',
    targetType: 'Message',
    targetId: 'm1',
    targetMessageId: 'm1',
    diff: null,
    reason: null,
    ipAddress: null,
    userAgent: null,
    claimId: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...p,
  };
}

describe('buildAuditFilter', () => {
  it('returns undefined when no filter active', () => {
    expect(buildAuditFilter({})).toBeUndefined();
    expect(buildAuditFilter({ actorId: '   ' })).toBeUndefined();
  });

  it('returns a bare predicate for a single filter', () => {
    expect(buildAuditFilter({ action: 'USER_BAN' })).toEqual({ action: { eq: 'USER_BAN' } });
  });

  it('combines multiple filters under `and`', () => {
    const f = buildAuditFilter({ action: 'USER_BAN', actorId: 'sub-9', targetType: 'User' });
    expect(f).toEqual({
      and: [
        { action: { eq: 'USER_BAN' } },
        { actorId: { eq: 'sub-9' } },
        { targetType: { eq: 'User' } },
      ],
    });
  });

  it('trims actor/target text inputs', () => {
    expect(buildAuditFilter({ targetId: '  m1  ' })).toEqual({ targetId: { eq: 'm1' } });
  });

  it('widens bare date bounds to start/end of UTC day', () => {
    const f = buildAuditFilter({ dateFrom: '2026-05-01', dateTo: '2026-05-31' });
    expect(f).toEqual({
      and: [
        { createdAt: { ge: '2026-05-01T00:00:00.000Z' } },
        { createdAt: { le: '2026-05-31T23:59:59.999Z' } },
      ],
    });
  });

  it('passes through full ISO timestamps untouched', () => {
    const f = buildAuditFilter({ dateFrom: '2026-05-01T12:00:00.000Z' });
    expect(f).toEqual({ createdAt: { ge: '2026-05-01T12:00:00.000Z' } });
  });
});

describe('csvEscape', () => {
  it('leaves plain values alone', () => {
    expect(csvEscape('hello')).toBe('hello');
  });
  it('quotes values with commas', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });
  it('escapes embedded quotes by doubling', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes values with newlines', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('toCsv', () => {
  it('writes a header row and one line per audit row', () => {
    const csv = toCsv([row({ id: 'a1' }), row({ id: 'a2', action: 'USER_BAN' })]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('createdAt');
    expect(lines[0]).toContain('action');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('MESSAGE_DELETE');
    expect(lines[2]).toContain('USER_BAN');
  });

  it('labels null actor as SYSTEM in the actor column', () => {
    const csv = toCsv([row({ actorId: null })]);
    expect(csv).toContain('SYSTEM');
  });

  it('serializes object diff payloads as JSON, escaped', () => {
    const csv = toCsv([row({ diff: { before: { x: 1 }, after: { x: 2 } } })]);
    // diff cell contains a comma → must be quoted
    expect(csv).toContain('"{""before""');
  });
});

describe('jsonDiff', () => {
  it('marks changed lines added/removed', () => {
    const segs = jsonDiff({ type: 'B' }, { type: 'D' });
    const added = segs
      .filter((s) => s.type === 'added')
      .map((s) => s.value)
      .join('');
    const removed = segs
      .filter((s) => s.type === 'removed')
      .map((s) => s.value)
      .join('');
    expect(removed).toContain('"B"');
    expect(added).toContain('"D"');
  });

  it('treats null sides as empty objects', () => {
    const segs = jsonDiff(null, { a: 1 });
    const added = segs
      .filter((s) => s.type === 'added')
      .map((s) => s.value)
      .join('');
    expect(added).toContain('"a"');
  });

  it('emits only unchanged segments for identical inputs', () => {
    const segs = jsonDiff({ a: 1 }, { a: 1 });
    expect(segs.every((s) => s.type === 'unchanged')).toBe(true);
  });
});

describe('splitDiffPayload', () => {
  it('extracts before/after', () => {
    expect(splitDiffPayload({ before: { a: 1 }, after: { a: 2 } })).toEqual({
      before: { a: 1 },
      after: { a: 2 },
    });
  });
  it('extracts prev/next', () => {
    expect(splitDiffPayload({ prev: 1, next: 2 })).toEqual({ before: 1, after: 2 });
  });
  it('falls back to whole payload as after', () => {
    expect(splitDiffPayload({ count: 9 })).toEqual({ before: null, after: { count: 9 } });
  });
  it('handles null', () => {
    expect(splitDiffPayload(null)).toEqual({ before: null, after: null });
  });
});

describe('actorLabel', () => {
  it('returns SYSTEM for null/blank', () => {
    expect(actorLabel(null)).toBe('SYSTEM');
    expect(actorLabel('  ')).toBe('SYSTEM');
  });
  it('returns the id otherwise', () => {
    expect(actorLabel('sub-1')).toBe('sub-1');
  });
});

describe('toAuditRow', () => {
  it('normalizes missing fields to null and defaults action', () => {
    const r = toAuditRow({ id: 'x' });
    expect(r.actorId).toBeNull();
    expect(r.action).toBe('OTHER');
    expect(r.createdAt).toBeNull();
  });
});
