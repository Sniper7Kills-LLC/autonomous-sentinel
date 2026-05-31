import { describe, it, expect } from 'vitest';
import {
  coerceTranscripts,
  upsertTranscript,
  selectPrimary,
  type RecordingTranscript,
} from './transcripts';

describe('coerceTranscripts (#593)', () => {
  it('returns [] for null/undefined/non-array', () => {
    expect(coerceTranscripts(null)).toEqual([]);
    expect(coerceTranscripts(undefined)).toEqual([]);
    expect(coerceTranscripts(42)).toEqual([]);
    expect(coerceTranscripts({ backend: 'x' })).toEqual([]);
  });

  it('parses a JSON-string value (older/seeded rows)', () => {
    const json = JSON.stringify([
      { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: 0.8, ts: 't1' },
    ]);
    expect(coerceTranscripts(json)).toEqual([
      { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: 0.8, ts: 't1' },
    ]);
  });

  it('passes through a parsed array and drops malformed entries', () => {
    const out = coerceTranscripts([
      { backend: 'whisper-local', transcript: 'A', ts: 't1' },
      { backend: '', transcript: 'bad' },
      { transcript: 'no backend' },
      { backend: 'amazon-transcribe', transcript: 'B', transcriptionConfidence: 0.9, ts: 't2' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.backend)).toEqual(['whisper-local', 'amazon-transcribe']);
    expect(out[0]?.transcriptionConfidence).toBeNull();
  });

  it('returns [] on an unparseable JSON string', () => {
    expect(coerceTranscripts('{not json')).toEqual([]);
  });
});

describe('upsertTranscript (#593)', () => {
  const base: RecordingTranscript[] = [
    { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: 0.7, ts: 't1' },
  ];

  it('appends a new backend without touching the others', () => {
    const next = upsertTranscript(base, {
      backend: 'amazon-transcribe',
      transcript: 'B',
      transcriptionConfidence: 0.9,
      ts: 't2',
    });
    expect(next).toHaveLength(2);
    expect(next.map((t) => t.backend)).toEqual(['whisper-local', 'amazon-transcribe']);
    // original untouched
    expect(base).toHaveLength(1);
  });

  it('replaces the entry for the SAME backend (re-transcribe overwrites its own pass)', () => {
    const next = upsertTranscript(base, {
      backend: 'whisper-local',
      transcript: 'A2',
      transcriptionConfidence: 0.95,
      ts: 't3',
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.transcript).toBe('A2');
    expect(next[0]?.transcriptionConfidence).toBe(0.95);
  });
});

describe('selectPrimary (#593)', () => {
  it('returns null for empty', () => {
    expect(selectPrimary([])).toBeNull();
  });

  it('picks the highest-confidence entry', () => {
    const p = selectPrimary([
      { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: 0.7, ts: 't1' },
      { backend: 'amazon-transcribe', transcript: 'B', transcriptionConfidence: 0.9, ts: 't2' },
    ]);
    expect(p?.backend).toBe('amazon-transcribe');
  });

  it('sorts no-confidence entries last', () => {
    const p = selectPrimary([
      { backend: 'amazon-transcribe', transcript: 'B', transcriptionConfidence: null, ts: 't2' },
      { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: 0.5, ts: 't1' },
    ]);
    expect(p?.backend).toBe('whisper-local');
  });

  it('breaks confidence ties to the most-recent ts', () => {
    const p = selectPrimary([
      { backend: 'whisper-local', transcript: 'A', transcriptionConfidence: 0.8, ts: '2026-01-01' },
      {
        backend: 'amazon-transcribe',
        transcript: 'B',
        transcriptionConfidence: 0.8,
        ts: '2026-02-01',
      },
    ]);
    expect(p?.backend).toBe('amazon-transcribe');
  });

  it('a single entry is trivially primary (single-whisper unchanged)', () => {
    const p = selectPrimary([
      { backend: 'whisper-local', transcript: 'SOLO', transcriptionConfidence: 0.6, ts: 't1' },
    ]);
    expect(p?.transcript).toBe('SOLO');
  });
});
