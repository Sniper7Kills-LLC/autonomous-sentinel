import { describe, it, expect } from 'vitest';
import { buildJobName, recordingIdFromJobName, JOB_NAME_PREFIX } from './job-name';

describe('buildJobName', () => {
  it('embeds the recordingId and is namespaced', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const name = buildJobName(id, { now: () => 1700000000000, rand: () => 0.5 });
    expect(name.startsWith(JOB_NAME_PREFIX)).toBe(true);
    expect(name).toContain(id);
    expect(recordingIdFromJobName(name)).toBe(id);
  });

  it('produces a Transcribe-legal job name (only [0-9a-zA-Z._-])', () => {
    const name = buildJobName('abc-123', { now: () => 1, rand: () => 0 });
    expect(name).toMatch(/^[0-9a-zA-Z._-]+$/);
  });

  it('sanitises illegal chars in a non-UUID recordingId', () => {
    const name = buildJobName('weird id/with*chars', { now: () => 1, rand: () => 0 });
    expect(name).toMatch(/^[0-9a-zA-Z._-]+$/);
    // The decoder recovers the SANITISED id (illegal chars → `_`).
    expect(recordingIdFromJobName(name)).toBe('weird_id_with_chars');
  });

  it('two runs of the same recordingId do not collide', () => {
    const id = 'aaaa-bbbb';
    const a = buildJobName(id, { now: () => 1000, rand: () => 0.1 });
    const b = buildJobName(id, { now: () => 1001, rand: () => 0.9 });
    expect(a).not.toBe(b);
    expect(recordingIdFromJobName(a)).toBe(id);
    expect(recordingIdFromJobName(b)).toBe(id);
  });

  it('caps the job name at 200 chars', () => {
    const longId = 'x'.repeat(500);
    const name = buildJobName(longId, { now: () => 1, rand: () => 0 });
    expect(name.length).toBeLessThanOrEqual(200);
  });

  it('throws on an empty recordingId', () => {
    expect(() => buildJobName('')).toThrow();
    expect(() => buildJobName('   ')).toThrow();
  });
});

describe('recordingIdFromJobName', () => {
  it('returns null for a foreign / non-namespaced job name', () => {
    expect(recordingIdFromJobName('some-other-job-123')).toBeNull();
    expect(recordingIdFromJobName('Transcribe-Job-Whatever')).toBeNull();
  });

  it('returns null for null / undefined / empty', () => {
    expect(recordingIdFromJobName(null)).toBeNull();
    expect(recordingIdFromJobName(undefined)).toBeNull();
    expect(recordingIdFromJobName('')).toBeNull();
  });

  it('returns null for a namespaced name missing the suffix fields', () => {
    expect(recordingIdFromJobName('eam-onlyid')).toBeNull();
    expect(recordingIdFromJobName('eam-id-1')).toBeNull();
  });
});
