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
      webCanonicalKey: 'recordings/web/r1.opus',
      wordTimestampsKey: 'recordings/web/r1.words.json',
      peaksJsonKey: 'recordings/web/r1.peaks.json',
      transcriptionConfidence: 0.73,
    });
    expect(r.frequencyKhz).toBe(11175);
    expect(r.modulation).toBe('USB');
    expect(r.automated).toBe(true);
    expect(r.sdrId).toBe('s1');
    expect(r.webCanonicalKey).toBe('recordings/web/r1.opus');
    expect(r.wordTimestampsKey).toBe('recordings/web/r1.words.json');
    expect(r.peaksJsonKey).toBe('recordings/web/r1.peaks.json');
    expect(r.transcriptionConfidence).toBe(0.73);
  });

  it('treats undefined fields as null/false', () => {
    const r = toDisplayRecording({ id: 'r2' });
    expect(r.frequencyKhz).toBeNull();
    expect(r.modulation).toBeNull();
    expect(r.transcript).toBeNull();
    expect(r.automated).toBe(false);
    expect(r.webCanonicalKey).toBeNull();
    expect(r.wordTimestampsKey).toBeNull();
    expect(r.peaksJsonKey).toBeNull();
    expect(r.transcriptionConfidence).toBeNull();
    expect(r.linguisticAttempts).toEqual([]);
    expect(r.transcripts).toEqual([]);
  });

  it('parses the per-backend transcripts collection (#593) from a parsed array', () => {
    const r = toDisplayRecording({
      id: 'r-multi',
      transcripts: [
        { backend: 'whisper-local', transcript: 'OXTRA', transcriptionConfidence: 0.7 },
        { backend: 'amazon-transcribe', transcript: 'FOXTROT', transcriptionConfidence: 0.9 },
        { backend: 'bad' }, // missing transcript → dropped
      ],
    });
    expect(r.transcripts).toEqual([
      { backend: 'whisper-local', transcript: 'OXTRA', transcriptionConfidence: 0.7 },
      { backend: 'amazon-transcribe', transcript: 'FOXTROT', transcriptionConfidence: 0.9 },
    ]);
  });

  it('parses transcripts delivered as a JSON string and tolerates bad JSON', () => {
    const r = toDisplayRecording({
      id: 'r-str',
      transcripts: JSON.stringify([
        { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: null },
      ]),
    });
    expect(r.transcripts).toEqual([
      { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: null },
    ]);
    expect(toDisplayRecording({ id: 'r-bad', transcripts: '{not json' }).transcripts).toEqual([]);
  });

  it('parses linguisticAttempts from a parsed array, tolerating ts/timestamp', () => {
    const r = toDisplayRecording({
      id: 'r3',
      linguisticAttempts: [
        {
          provider: 'rules',
          success: true,
          promptVersion: 2,
          promptHash: 'ph',
          resultHash: 'rh',
          timestamp: '2026-05-30T00:00:00Z',
        },
        { provider: 'bedrock', success: false, promptVersion: 1, ts: '2026-05-30T00:01:00Z' },
      ],
    });
    expect(r.linguisticAttempts).toHaveLength(2);
    expect(r.linguisticAttempts[0]).toMatchObject({
      provider: 'rules',
      success: true,
      promptVersion: 2,
      ts: '2026-05-30T00:00:00Z',
    });
    expect(r.linguisticAttempts[1]).toMatchObject({
      provider: 'bedrock',
      success: false,
      ts: '2026-05-30T00:01:00Z',
    });
  });

  it('parses linguisticAttempts when delivered as a JSON string', () => {
    const r = toDisplayRecording({
      id: 'r4',
      linguisticAttempts: JSON.stringify([{ provider: 'rules', success: true }]),
    });
    expect(r.linguisticAttempts).toEqual([
      {
        provider: 'rules',
        success: true,
        promptVersion: null,
        promptHash: null,
        resultHash: null,
        ts: null,
      },
    ]);
  });

  it('returns an empty attempts array for malformed JSON or non-arrays', () => {
    expect(
      toDisplayRecording({ id: 'r5', linguisticAttempts: '{not json' }).linguisticAttempts,
    ).toEqual([]);
    expect(
      toDisplayRecording({ id: 'r6', linguisticAttempts: { foo: 1 } }).linguisticAttempts,
    ).toEqual([]);
  });
});
