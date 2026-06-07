import { describe, it, expect, vi } from 'vitest';
import { statusToStage, toUploadRow, observeMyUploads } from './query';

let capturedObserveInput: { filter: unknown; authMode: string } | null = null;
let capturedCbs: {
  next: (snap: { items: unknown[] }) => void;
  error?: (e: unknown) => void;
} | null = null;
const unsubscribeMock = vi.fn();
vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    models: {
      Recording: {
        observeQuery: (input: { filter: unknown; authMode: string }) => {
          capturedObserveInput = input;
          return {
            subscribe: (cbs: {
              next: (snap: { items: unknown[] }) => void;
              error?: (e: unknown) => void;
            }) => {
              capturedCbs = cbs;
              return { unsubscribe: unsubscribeMock };
            },
          };
        },
      },
    },
  }),
}));

describe('toUploadRow', () => {
  it('copies known fields + threads failure metadata through', () => {
    const r = toUploadRow({
      id: 'rec-1',
      uploaderId: 'sub-1',
      messageId: 'msg-1',
      contentHash: 'abc',
      originalKey: 'recordings/originals/abc.wav',
      webCanonicalKey: 'recordings/web/rec-1.opus',
      transcriptionStatus: 'PREPROCESS_FAILED',
      transcriptionStatusUpdatedAt: '2026-05-28T20:00:00Z',
      failedReason: 'ffmpeg exit 1',
      frequencyKhz: 11175,
      modulation: 'USB',
      broadcastedAt: '2026-05-28T19:59:00Z',
      durationMs: 4200,
      sdrId: 'sdr-1',
      automated: true,
      createdAt: '2026-05-28T19:58:00Z',
    });
    expect(r.id).toBe('rec-1');
    expect(r.transcriptionStatus).toBe('PREPROCESS_FAILED');
    expect(r.failedReason).toBe('ffmpeg exit 1');
    expect(r.messageId).toBe('msg-1');
    expect(r.originalKey).toBe('recordings/originals/abc.wav');
    expect(r.createdAt).toBe('2026-05-28T19:58:00Z');
    expect(r.frequencyKhz).toBe(11175);
  });

  it('defaults missing fields to nulls / false', () => {
    const r = toUploadRow({ id: 'rec-2' });
    expect(r.messageId).toBeNull();
    expect(r.failedReason).toBeNull();
    expect(r.automated).toBe(false);
    expect(r.transcriptionStatus).toBeNull();
  });
});

describe('statusToStage', () => {
  it('maps every backend enum value to a known stage', () => {
    expect(statusToStage('QUEUED')).toBe('queued');
    expect(statusToStage('PREPROCESSING')).toBe('preprocessing');
    expect(statusToStage('PREPROCESS_FAILED')).toBe('preprocess_failed');
    expect(statusToStage('TRANSCRIBING')).toBe('transcribing');
    expect(statusToStage('TRANSCRIBE_FAILED')).toBe('transcribe_failed');
    expect(statusToStage('PARSING')).toBe('parsing');
    expect(statusToStage('PARSE_FAILED')).toBe('parse_failed');
    expect(statusToStage('PUBLISHED')).toBe('published');
    expect(statusToStage('FAILED')).toBe('failed');
  });

  it('falls back to `unknown` for any other value', () => {
    expect(statusToStage(null)).toBe('unknown');
    expect(statusToStage(undefined)).toBe('unknown');
    expect(statusToStage('BOGUS')).toBe('unknown');
  });
});

describe('observeMyUploads (#774)', () => {
  it('subscribes by uploaderId (userPool) and delivers mapped, newest-first rows', () => {
    const next = vi.fn();
    const sub = observeMyUploads('sub-1', { next });

    // Filter scopes to the caller + excludes soft-deleted; userPool auth.
    expect(capturedObserveInput?.authMode).toBe('userPool');
    expect(capturedObserveInput?.filter).toEqual({
      and: [{ uploaderId: { eq: 'sub-1' } }, { deletedAt: { attributeExists: false } }],
    });

    // A snapshot of two raw recordings, out of order, is mapped + sorted desc.
    capturedCbs?.next({
      items: [
        { id: 'old', createdAt: '2026-05-01T00:00:00Z', transcriptionStatus: 'PUBLISHED' },
        { id: 'new', createdAt: '2026-05-03T00:00:00Z', transcriptionStatus: 'QUEUED' },
      ],
    });
    const rows = next.mock.calls[0]?.[0] as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);

    sub.unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('forwards subscription errors to the error handler', () => {
    const next = vi.fn();
    const error = vi.fn();
    observeMyUploads('sub-1', { next, error });
    capturedCbs?.error?.(new Error('boom'));
    expect(error).toHaveBeenCalledWith(new Error('boom'));
  });
});
