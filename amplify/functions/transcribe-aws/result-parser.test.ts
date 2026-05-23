import { describe, it, expect } from 'vitest';
import { parseTranscribeResult, type TranscribeOutputJson } from './result-parser';

/**
 * Behaviour tests for the Transcribe result parser (#56).
 *
 * Pins canonical Transcript projection from a Transcribe output
 * JSON: transcript text, language code, language confidence
 * (string + number), word-level timestamps via the shared
 * normaliser, plus the defensive throws on malformed shapes.
 */

const FULL_PAYLOAD: TranscribeOutputJson = {
  jobName: 'rec-1',
  status: 'COMPLETED',
  results: {
    transcripts: [{ transcript: 'SKYKING SKYKING DELTA OSCAR.' }],
    language_code: 'en-US',
    language_identification: [{ code: 'en-US', score: '0.97' }],
    items: [
      {
        type: 'pronunciation',
        start_time: '0.0',
        end_time: '0.5',
        alternatives: [{ content: 'SKYKING', confidence: '0.97' }],
      },
      {
        type: 'pronunciation',
        start_time: '0.6',
        end_time: '1.1',
        alternatives: [{ content: 'SKYKING', confidence: '0.95' }],
      },
      {
        type: 'punctuation',
        alternatives: [{ content: '.' }],
      },
      {
        type: 'pronunciation',
        start_time: '1.3',
        end_time: '1.7',
        alternatives: [{ content: 'DELTA', confidence: '0.93' }],
      },
      {
        type: 'pronunciation',
        start_time: '1.8',
        end_time: '2.4',
        alternatives: [{ content: 'OSCAR', confidence: '0.91' }],
      },
    ],
  },
};

describe('parseTranscribeResult — happy path', () => {
  it('projects the full payload onto the canonical Transcript shape', () => {
    const out = parseTranscribeResult(FULL_PAYLOAD);
    expect(out.text).toBe('SKYKING SKYKING DELTA OSCAR.');
    expect(out.language).toBe('en-US');
    expect(out.languageConfidence).toBeCloseTo(0.97);
    expect(out.words.map((w) => w.word)).toEqual(['SKYKING', 'SKYKING', 'DELTA', 'OSCAR']);
    expect(out.words[0]).toEqual({
      word: 'SKYKING',
      startMs: 0,
      endMs: 500,
      confidence: 0.97,
    });
  });

  it('handles numeric (non-string) language confidence', () => {
    const out = parseTranscribeResult({
      ...FULL_PAYLOAD,
      results: {
        ...FULL_PAYLOAD.results,
        language_identification: [{ code: 'en-US', score: 0.88 }],
      },
    });
    expect(out.languageConfidence).toBe(0.88);
  });

  it('returns languageConfidence=null when language_identification is missing', () => {
    const out = parseTranscribeResult({
      ...FULL_PAYLOAD,
      results: {
        ...FULL_PAYLOAD.results,
        language_identification: undefined,
      },
    });
    expect(out.languageConfidence).toBeNull();
    expect(out.language).toBe('en-US'); // language code still present
  });

  it('returns language=null when language_code is missing', () => {
    const out = parseTranscribeResult({
      ...FULL_PAYLOAD,
      results: {
        ...FULL_PAYLOAD.results,
        language_code: undefined,
      },
    });
    expect(out.language).toBeNull();
  });

  it('returns empty words[] when results.items is missing', () => {
    const out = parseTranscribeResult({
      ...FULL_PAYLOAD,
      results: {
        ...FULL_PAYLOAD.results,
        items: undefined,
      },
    });
    expect(out.words).toEqual([]);
  });
});

describe('parseTranscribeResult — malformed input', () => {
  it('throws on null / non-object payload', () => {
    expect(() => parseTranscribeResult(null)).toThrow(/not an object/);
    expect(() => parseTranscribeResult(undefined)).toThrow(/not an object/);
  });

  it('throws when results is missing', () => {
    expect(() => parseTranscribeResult({ jobName: 'rec-1' })).toThrow(/results is missing/);
  });

  it('throws when results.transcripts is missing or empty', () => {
    expect(() => parseTranscribeResult({ results: { transcripts: [] } })).toThrow(
      /transcripts is missing or empty/,
    );
    expect(() => parseTranscribeResult({ results: {} })).toThrow(/transcripts is missing or empty/);
  });

  it('throws when transcripts[0].transcript is not a string', () => {
    expect(() =>
      parseTranscribeResult({
        results: { transcripts: [{ transcript: 42 as unknown as string }] },
      }),
    ).toThrow(/transcript is not a string/);
  });

  it('throws on empty / whitespace-only transcript (transcription_failed)', () => {
    expect(() =>
      parseTranscribeResult({
        results: { transcripts: [{ transcript: '' }] },
      }),
    ).toThrow(/transcription_failed/);
    expect(() =>
      parseTranscribeResult({
        results: { transcripts: [{ transcript: '   ' }] },
      }),
    ).toThrow(/transcription_failed/);
  });
});
