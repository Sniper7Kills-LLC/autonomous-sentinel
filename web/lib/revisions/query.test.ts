import { describe, it, expect } from 'vitest';
import { toDisplayRevision } from './query';

describe('toDisplayRevision', () => {
  it('copies known fields', () => {
    const r = toDisplayRevision({
      id: 'rev-1',
      recordingId: 'rec-1',
      proposedText: 'SKYKING BEARS',
      proposedBy: 'user-sub',
      source: 'MANUAL',
      voteScore: 1.5,
      accepted: false,
      acceptedAt: null,
      superseded: false,
      createdAt: '2026-05-27T12:00:00Z',
    });
    expect(r.id).toBe('rev-1');
    expect(r.proposedText).toBe('SKYKING BEARS');
    expect(r.source).toBe('MANUAL');
    expect(r.voteScore).toBe(1.5);
    expect(r.accepted).toBe(false);
  });

  it('normalises absent fields to safe defaults', () => {
    const r = toDisplayRevision({ id: 'rev-2', recordingId: 'rec-2' });
    expect(r.proposedText).toBe('');
    expect(r.voteScore).toBe(0);
    expect(r.accepted).toBe(false);
    expect(r.source).toBeNull();
  });

  it('rejects unknown source values', () => {
    expect(toDisplayRevision({ id: 'r', recordingId: 'rec', source: 'BOGUS' }).source).toBeNull();
  });
});
