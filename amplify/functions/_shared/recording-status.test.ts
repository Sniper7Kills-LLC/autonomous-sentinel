import { describe, it, expect } from 'vitest';
import { isTerminalRecordingStatus, forwardStatusRank, hasReachedStatus } from './recording-status';

describe('recording-status (#741)', () => {
  describe('isTerminalRecordingStatus', () => {
    it('flags the terminal states', () => {
      for (const s of [
        'PUBLISHED',
        'PREPROCESS_FAILED',
        'TRANSCRIBE_FAILED',
        'PARSE_FAILED',
        'FAILED',
      ]) {
        expect(isTerminalRecordingStatus(s)).toBe(true);
      }
    });
    it('does not flag in-progress / unknown / null', () => {
      for (const s of [
        'QUEUED',
        'PREPROCESSING',
        'TRANSCRIBING',
        'PARSING',
        'NOPE',
        null,
        undefined,
      ]) {
        expect(isTerminalRecordingStatus(s)).toBe(false);
      }
    });
  });

  describe('forwardStatusRank', () => {
    it('orders the forward ladder', () => {
      expect(forwardStatusRank('QUEUED')).toBe(0);
      expect(forwardStatusRank('PREPROCESSING')).toBe(1);
      expect(forwardStatusRank('TRANSCRIBING')).toBe(2);
      expect(forwardStatusRank('PARSING')).toBe(3);
      expect(forwardStatusRank('PUBLISHED')).toBe(4);
    });
    it('returns -1 for failure/unknown/null', () => {
      expect(forwardStatusRank('PARSE_FAILED')).toBe(-1);
      expect(forwardStatusRank('NOPE')).toBe(-1);
      expect(forwardStatusRank(null)).toBe(-1);
    });
  });

  describe('hasReachedStatus', () => {
    it('treats null/unknown current as fresh (proceed)', () => {
      expect(hasReachedStatus(null, 'TRANSCRIBING')).toBe(false);
      expect(hasReachedStatus(undefined, 'TRANSCRIBING')).toBe(false);
      expect(hasReachedStatus('NOPE', 'TRANSCRIBING')).toBe(false);
    });
    it('preprocess guard (target TRANSCRIBING): proceeds from QUEUED/PREPROCESSING, skips once at/past', () => {
      expect(hasReachedStatus('QUEUED', 'TRANSCRIBING')).toBe(false);
      expect(hasReachedStatus('PREPROCESSING', 'TRANSCRIBING')).toBe(false);
      expect(hasReachedStatus('TRANSCRIBING', 'TRANSCRIBING')).toBe(true);
      expect(hasReachedStatus('PARSING', 'TRANSCRIBING')).toBe(true);
      expect(hasReachedStatus('PUBLISHED', 'TRANSCRIBING')).toBe(true);
    });
    it('any terminal current short-circuits to true (no regression)', () => {
      expect(hasReachedStatus('PARSE_FAILED', 'TRANSCRIBING')).toBe(true);
      expect(hasReachedStatus('TRANSCRIBE_FAILED', 'PUBLISHED')).toBe(true);
    });
  });
});
