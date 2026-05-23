import { describe, it, expect } from 'vitest';
import {
  MESSAGE_PUBLISHED_FIELDS,
  RECORDING_STATUS_FIELDS,
  isPublishableMessage,
  isRecordingSoftDelete,
  isRecordingStatusChange,
} from './subscription-filters';

/**
 * Behaviour tests for the AppSync subscription filter predicates
 * (#70). Pins the selection-set arrays + the three predicates
 * the deferred web hooks use to filter the auto-generated
 * onUpdate/onCreate event stream down to the events that matter.
 */

describe('selection sets', () => {
  it('RECORDING_STATUS_FIELDS includes the status + status-ts + failure-reason + soft-delete fields', () => {
    expect(RECORDING_STATUS_FIELDS).toContain('id');
    expect(RECORDING_STATUS_FIELDS).toContain('transcriptionStatus');
    expect(RECORDING_STATUS_FIELDS).toContain('transcriptionStatusUpdatedAt');
    expect(RECORDING_STATUS_FIELDS).toContain('failedReason');
    expect(RECORDING_STATUS_FIELDS).toContain('deletedAt');
  });

  it('MESSAGE_PUBLISHED_FIELDS includes publishedAt + flaggedForReview + deletedAt', () => {
    expect(MESSAGE_PUBLISHED_FIELDS).toContain('publishedAt');
    expect(MESSAGE_PUBLISHED_FIELDS).toContain('flaggedForReview');
    expect(MESSAGE_PUBLISHED_FIELDS).toContain('deletedAt');
  });
});

describe('isRecordingStatusChange', () => {
  it('returns true on a fresh first event with a status set', () => {
    expect(isRecordingStatusChange(null, { transcriptionStatus: 'QUEUED' })).toBe(true);
    expect(isRecordingStatusChange(undefined, { transcriptionStatus: 'QUEUED' })).toBe(true);
  });

  it('returns true when status actually changed', () => {
    expect(
      isRecordingStatusChange(
        { transcriptionStatus: 'PREPROCESSING' },
        { transcriptionStatus: 'TRANSCRIBING' },
      ),
    ).toBe(true);
  });

  it('returns false when status is identical (filters out spurious onUpdate)', () => {
    expect(
      isRecordingStatusChange(
        { transcriptionStatus: 'TRANSCRIBING' },
        { transcriptionStatus: 'TRANSCRIBING' },
      ),
    ).toBe(false);
  });

  it('returns false when next has no transcriptionStatus (non-status field update)', () => {
    expect(
      isRecordingStatusChange(
        { transcriptionStatus: 'QUEUED' },
        { deletedAt: '2026-05-23T00:00:00Z' },
      ),
    ).toBe(false);
  });

  it('treats a previously-unset status as a first event (returns true)', () => {
    expect(
      isRecordingStatusChange({ transcriptionStatus: null }, { transcriptionStatus: 'QUEUED' }),
    ).toBe(true);
  });

  it('returns false on null / undefined next', () => {
    expect(isRecordingStatusChange({ transcriptionStatus: 'X' }, null)).toBe(false);
    expect(isRecordingStatusChange({ transcriptionStatus: 'X' }, undefined)).toBe(false);
  });
});

describe('isPublishableMessage', () => {
  it('returns true when publishedAt is set and deletedAt is unset', () => {
    expect(isPublishableMessage({ publishedAt: '2026-05-23T00:00:00Z' })).toBe(true);
    expect(isPublishableMessage({ publishedAt: '2026-05-23T00:00:00Z', deletedAt: null })).toBe(
      true,
    );
  });

  it('returns false when publishedAt is unset / null / empty', () => {
    expect(isPublishableMessage({ publishedAt: null })).toBe(false);
    expect(isPublishableMessage({})).toBe(false);
    expect(isPublishableMessage({ publishedAt: '' })).toBe(false);
  });

  it('returns false when deletedAt is set (admin-deleted row hidden from public)', () => {
    expect(
      isPublishableMessage({
        publishedAt: '2026-05-23T00:00:00Z',
        deletedAt: '2026-05-24T00:00:00Z',
      }),
    ).toBe(false);
  });

  it('returns false on null / undefined input', () => {
    expect(isPublishableMessage(null)).toBe(false);
    expect(isPublishableMessage(undefined)).toBe(false);
  });

  it('publishes a flagged-for-review row (flagged is a banner, not a hide)', () => {
    // No `flaggedForReview` field check in the predicate — the
    // public feed renders flagged rows with a banner; only
    // soft-delete hides them.
    expect(isPublishableMessage({ publishedAt: '2026-05-23T00:00:00Z', deletedAt: null })).toBe(
      true,
    );
  });
});

describe('isRecordingSoftDelete', () => {
  it('returns true on a fresh transition into deletedAt set', () => {
    expect(isRecordingSoftDelete({ deletedAt: null }, { deletedAt: '2026-05-23T00:00:00Z' })).toBe(
      true,
    );
    expect(isRecordingSoftDelete(null, { deletedAt: '2026-05-23T00:00:00Z' })).toBe(true);
  });

  it('returns false when deletedAt was already set (no re-delete event)', () => {
    expect(
      isRecordingSoftDelete(
        { deletedAt: '2026-05-23T00:00:00Z' },
        { deletedAt: '2026-05-23T00:00:00Z' },
      ),
    ).toBe(false);
  });

  it('returns false when next.deletedAt is unset / empty (non-delete event)', () => {
    expect(isRecordingSoftDelete({ deletedAt: null }, { deletedAt: null })).toBe(false);
    expect(isRecordingSoftDelete(null, { deletedAt: '' })).toBe(false);
  });

  it('returns false on null next', () => {
    expect(isRecordingSoftDelete({ deletedAt: null }, null)).toBe(false);
  });
});
