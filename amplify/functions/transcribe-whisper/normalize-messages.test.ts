import { describe, it, expect, vi } from 'vitest';
import { normalizeMessages } from './handler.mjs';

/**
 * Whisper handler event-shape normalization (#587).
 *
 * The transcribe-dispatch Lambda Event-invokes the whisper container
 * with the dispatch-message body as the payload. The handler must still
 * accept the legacy SQS event shape too (an in-flight queue message at
 * deploy time / a direct queue subscription in a sandbox).
 */

describe('normalizeMessages — SQS event shape (legacy)', () => {
  it('JSON-parses each record body into a message object', () => {
    const event = {
      Records: [
        { body: JSON.stringify({ recordingId: 'r1', originalKey: 'k1' }) },
        { body: JSON.stringify({ recordingId: 'r2', originalKey: 'k2' }) },
      ],
    };
    expect(normalizeMessages(event)).toEqual([
      { recordingId: 'r1', originalKey: 'k1' },
      { recordingId: 'r2', originalKey: 'k2' },
    ]);
  });

  it('skips an unparseable record but keeps the good ones', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = {
      Records: [{ body: '{not json' }, { body: JSON.stringify({ recordingId: 'r2' }) }],
    };
    expect(normalizeMessages(event)).toEqual([{ recordingId: 'r2' }]);
  });
});

describe('normalizeMessages — direct dispatch payload (#587)', () => {
  it('wraps a direct message object (with recordingId) in a single-element list', () => {
    const payload = { recordingId: 'r1', originalKey: 'recordings/originals/r1.wav' };
    expect(normalizeMessages(payload)).toEqual([payload]);
  });

  it('preserves backendOverride on the direct payload', () => {
    const payload = { recordingId: 'r1', originalKey: 'k', backendOverride: 'whisper-local' };
    expect(normalizeMessages(payload)).toEqual([payload]);
  });

  it('ignores a payload with no recordingId (stray / keep-warm invoke)', () => {
    expect(normalizeMessages({ foo: 'bar' })).toEqual([]);
    expect(normalizeMessages(null)).toEqual([]);
    expect(normalizeMessages(undefined)).toEqual([]);
  });
});
