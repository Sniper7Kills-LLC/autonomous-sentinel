import { describe, it, expect } from 'vitest';
import { shortSub, toUserLabel } from './label';

describe('shortSub', () => {
  it('truncates a long sub with an ellipsis', () => {
    expect(shortSub('abcdefghijklmnop')).toBe('abcdefgh…');
  });

  it('leaves a short sub untouched', () => {
    expect(shortSub('abc123')).toBe('abc123');
  });
});

describe('toUserLabel', () => {
  it('prefers displayName over preferredUsername', () => {
    const r = toUserLabel('sub-1', { displayName: 'Sierra', preferredUsername: 'sierra77' });
    expect(r).toEqual({ sub: 'sub-1', label: 'Sierra', piiBlanked: false });
  });

  it('falls back to preferredUsername when displayName is absent', () => {
    const r = toUserLabel('sub-2', { preferredUsername: 'sierra77' });
    expect(r.label).toBe('sierra77');
  });

  it('falls back to a short sub when no public name is set', () => {
    const r = toUserLabel('abcdefghijklmnop', {});
    expect(r.label).toBe('abcdefgh…');
  });

  it('falls back to a short sub when the row is missing', () => {
    const r = toUserLabel('abcdefghijklmnop', null);
    expect(r.label).toBe('abcdefgh…');
    expect(r.piiBlanked).toBe(false);
  });

  it('renders a deactivated label for a PII-blanked account', () => {
    const r = toUserLabel('sub-3', { piiBlanked: true, displayName: null });
    expect(r).toEqual({ sub: 'sub-3', label: 'deactivated account', piiBlanked: true });
  });
});
