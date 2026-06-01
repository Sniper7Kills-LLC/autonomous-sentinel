import { describe, it, expect } from 'vitest';
import {
  toDisplayProfile,
  toReputationStats,
  type RawReputation,
  type RawUserPublic,
} from './profile';

describe('toReputationStats', () => {
  it('copies numeric fields', () => {
    const s = toReputationStats({
      computedWeight: 3.5,
      validatedSubmissions: 12,
      acceptedCorrections: 4,
    });
    expect(s).toEqual({ computedWeight: 3.5, validatedSubmissions: 12, acceptedCorrections: 4 });
  });

  it('defaults missing fields (weight 1, counts 0)', () => {
    const empty: RawReputation = {};
    const s = toReputationStats(empty);
    expect(s).toEqual({ computedWeight: 1, validatedSubmissions: 0, acceptedCorrections: 0 });
  });
});

describe('toDisplayProfile', () => {
  const base: RawUserPublic = {
    cognitoSub: 'sub-123',
    preferredUsername: 'spectre',
    displayName: 'Spectre',
    role: 'moderator',
    piiBlanked: false,
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('maps a populated row with reputation', () => {
    const p = toDisplayProfile(base, { computedWeight: 2, validatedSubmissions: 5 });
    expect(p.id).toBe('sub-123');
    expect(p.displayName).toBe('Spectre');
    expect(p.handle).toBe('spectre');
    expect(p.role).toBe('moderator');
    expect(p.joinedAt).toBe('2026-01-01T00:00:00Z');
    expect(p.piiBlanked).toBe(false);
    expect(p.reputation).toEqual({
      computedWeight: 2,
      validatedSubmissions: 5,
      acceptedCorrections: 0,
    });
  });

  it('falls back displayName → preferredUsername', () => {
    const p = toDisplayProfile({ ...base, displayName: null }, null);
    expect(p.displayName).toBe('spectre');
    expect(p.handle).toBe('spectre');
  });

  it('null displayName + null handle when both absent', () => {
    const p = toDisplayProfile(
      { cognitoSub: 'sub-9', displayName: null, preferredUsername: null },
      null,
    );
    expect(p.displayName).toBeNull();
    expect(p.handle).toBeNull();
  });

  it('defaults an unknown / missing role to member', () => {
    expect(toDisplayProfile({ ...base, role: 'wizard' }, null).role).toBe('member');
    expect(toDisplayProfile({ ...base, role: null }, null).role).toBe('member');
  });

  it('reports piiBlanked for a self-deleted row (PII nulled by the Lambda)', () => {
    const p = toDisplayProfile(
      {
        cognitoSub: 'sub-x',
        displayName: null,
        preferredUsername: null,
        role: 'member',
        piiBlanked: true,
        createdAt: '2025-01-01T00:00:00Z',
      },
      null,
    );
    expect(p.piiBlanked).toBe(true);
    expect(p.displayName).toBeNull();
    expect(p.reputation).toBeNull();
  });

  it('reputation null when no rep row supplied', () => {
    expect(toDisplayProfile(base, null).reputation).toBeNull();
  });

  it('empty id when cognitoSub missing', () => {
    expect(toDisplayProfile({ cognitoSub: null }, null).id).toBe('');
  });
});
