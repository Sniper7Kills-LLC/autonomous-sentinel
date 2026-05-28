import { describe, it, expect } from 'vitest';
import { toDisplayRecording } from './recordings';

describe('toDisplayRecording', () => {
  it('copies known fields and nulls absent ones', () => {
    const r = toDisplayRecording({
      id: 'r1',
      frequencyKhz: 11175,
      modulation: 'USB',
      broadcastedAt: '2026-05-27T12:00:00Z',
      transcript: 'PT3 14 AB',
      transcriptionStatus: 'PUBLISHED',
      durationMs: 4200,
      sdrId: 's1',
      automated: true,
    });
    expect(r.frequencyKhz).toBe(11175);
    expect(r.modulation).toBe('USB');
    expect(r.automated).toBe(true);
    expect(r.sdrId).toBe('s1');
  });

  it('treats undefined fields as null/false', () => {
    const r = toDisplayRecording({ id: 'r2' });
    expect(r.frequencyKhz).toBeNull();
    expect(r.modulation).toBeNull();
    expect(r.transcript).toBeNull();
    expect(r.automated).toBe(false);
  });
});
