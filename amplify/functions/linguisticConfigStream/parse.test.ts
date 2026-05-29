import { describe, expect, it } from 'vitest';
import { parseConfigStreamRecord } from './parse';

describe('parseConfigStreamRecord — audit framing (#481a)', () => {
  it('frames an INSERT as an auditable update with empty before', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'INSERT',
      newImage: { key: 'CONFIDENCE_THRESHOLD_SKYKING', value: 0.8, createdById: 'admin-1' },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.key).toBe('CONFIDENCE_THRESHOLD_SKYKING');
    expect(parsed?.actorId).toBe('admin-1');
    expect(parsed?.isUpdate).toBe(true);
    expect(parsed?.before).toEqual({});
    expect(parsed?.after).toMatchObject({ key: 'CONFIDENCE_THRESHOLD_SKYKING', value: 0.8 });
  });

  it('frames a MODIFY with both snapshots for the diff', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'MODIFY',
      oldImage: { key: 'CONFIDENCE_THRESHOLD_SKYKING', value: 0.8, createdById: 'admin-1' },
      newImage: { key: 'CONFIDENCE_THRESHOLD_SKYKING', value: 0.9, createdById: 'admin-2' },
    });
    expect(parsed?.before).toMatchObject({ value: 0.8 });
    expect(parsed?.after).toMatchObject({ value: 0.9 });
    // Actor is whoever wrote the new image.
    expect(parsed?.actorId).toBe('admin-2');
  });

  it('frames a REMOVE as an auditable change with empty after', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'REMOVE',
      oldImage: { key: 'SKYKING_RULES', value: { a: 1 }, createdById: 'admin-1' },
    });
    expect(parsed?.isUpdate).toBe(true);
    expect(parsed?.after).toEqual({});
    expect(parsed?.before).toMatchObject({ key: 'SKYKING_RULES' });
    expect(parsed?.actorId).toBe('admin-1');
    expect(parsed?.isPromptVersionBump).toBe(false);
  });

  it('returns null when no key is present on either image', () => {
    expect(parseConfigStreamRecord({ eventName: 'MODIFY', newImage: { value: 1 } })).toBeNull();
    expect(parseConfigStreamRecord({ eventName: 'REMOVE' })).toBeNull();
  });

  it('actorId is null when neither image carries createdById', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'INSERT',
      newImage: { key: 'OTHER_KEY', value: 1 },
    });
    expect(parsed?.actorId).toBeNull();
  });
});

describe('parseConfigStreamRecord — prompt-version bump detection (#481b)', () => {
  it('flags a MODIFY that raises promptVersion on a *_PROMPT_VERSION key', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'MODIFY',
      oldImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 2, createdById: 'a' },
      newImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 3, createdById: 'a' },
    });
    expect(parsed?.isPromptVersionBump).toBe(true);
    expect(parsed?.newPromptVersion).toBe(3);
  });

  it('flags an INSERT of a *_PROMPT_VERSION key with a version', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'INSERT',
      newImage: { key: 'ALLSTATIONS_PROMPT_VERSION', promptVersion: 1, createdById: 'a' },
    });
    expect(parsed?.isPromptVersionBump).toBe(true);
    expect(parsed?.newPromptVersion).toBe(1);
  });

  it('does NOT flag when the version is unchanged', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'MODIFY',
      oldImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 3 },
      newImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 3 },
    });
    expect(parsed?.isPromptVersionBump).toBe(false);
    expect(parsed?.newPromptVersion).toBeNull();
  });

  it('does NOT flag a version decrease (rollback is not a reprocess trigger)', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'MODIFY',
      oldImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 5 },
      newImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 4 },
    });
    expect(parsed?.isPromptVersionBump).toBe(false);
  });

  it('does NOT flag a non-prompt-version key even when its value changes', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'MODIFY',
      oldImage: { key: 'CONFIDENCE_THRESHOLD_SKYKING', value: 0.8 },
      newImage: { key: 'CONFIDENCE_THRESHOLD_SKYKING', value: 0.9 },
    });
    expect(parsed?.isUpdate).toBe(true);
    expect(parsed?.isPromptVersionBump).toBe(false);
    expect(parsed?.newPromptVersion).toBeNull();
  });

  it('does NOT flag a *_PROMPT_VERSION key whose promptVersion is missing/non-numeric', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'INSERT',
      newImage: { key: 'SKYKING_PROMPT_VERSION', value: 'oops' },
    });
    expect(parsed?.isPromptVersionBump).toBe(false);
  });

  it('does NOT flag a REMOVE of a *_PROMPT_VERSION key', () => {
    const parsed = parseConfigStreamRecord({
      eventName: 'REMOVE',
      oldImage: { key: 'SKYKING_PROMPT_VERSION', promptVersion: 3 },
    });
    expect(parsed?.isPromptVersionBump).toBe(false);
  });
});
