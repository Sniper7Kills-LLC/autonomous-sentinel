import { describe, it, expect } from 'vitest';
import { diffTranscript, hasChanges } from './diff';

describe('diffTranscript', () => {
  it('marks unchanged text when nothing changes', () => {
    const segs = diffTranscript('SKYKING PT3 14 AB', 'SKYKING PT3 14 AB');
    expect(segs.every((s) => s.op === 'unchanged')).toBe(true);
    expect(hasChanges(segs)).toBe(false);
  });

  it('flags an added word', () => {
    const segs = diffTranscript('SKYKING PT3', 'SKYKING PT3 14');
    expect(segs.some((s) => s.op === 'added' && s.value.includes('14'))).toBe(true);
    expect(hasChanges(segs)).toBe(true);
  });

  it('flags a removed and added word on a substitution', () => {
    const segs = diffTranscript('SKYKING LIMA', 'SKYKING KILO');
    expect(segs.some((s) => s.op === 'removed' && s.value.includes('LIMA'))).toBe(true);
    expect(segs.some((s) => s.op === 'added' && s.value.includes('KILO'))).toBe(true);
    expect(hasChanges(segs)).toBe(true);
  });
});
