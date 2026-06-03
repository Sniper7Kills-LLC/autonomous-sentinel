import { describe, it, expect } from 'vitest';
import { BannedIp } from './banned-ip';

/**
 * Schema-shape tests for the BannedIp model (#200/#201).
 *
 * Pins the contract documented in the issue:
 *   - `cidr` is the identifier — one row per IPv4/IPv6 CIDR so the
 *     `wafSync` Lambda can fetch/reconcile by PK.
 *   - `scope` enum decides write-only (default) vs read+write block.
 *   - `expiresAt` is optional; a past value is dropped by the sync
 *     reconcile (no DynamoDB TTL attribute).
 *   - `reason` + `createdBy` carry admin provenance.
 *   - Authz: admin-only for everything. Ban lists are sensitive, so
 *     there is NO guest/public read.
 */

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime | undefined>;
    authorization: readonly AuthRuntime[];
    identifier: readonly string[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean; default?: unknown };
}

type AuthRuntime = Record<symbol, unknown>;

interface AuthData {
  strategy: string;
  groups?: readonly string[];
  operations?: readonly string[];
}

function authzRules(model: unknown): AuthData[] {
  const surface = model as { data: { authorization: readonly object[] } };
  return surface.data.authorization.map((rule): AuthData => {
    const sym = Object.getOwnPropertySymbols(rule).find(
      (s) => s.description?.toLowerCase() === 'data',
    );
    if (!sym) throw new Error('rule has no Symbol payload');
    const payload = (rule as Record<symbol, AuthData | undefined>)[sym];
    if (!payload) throw new Error('rule Symbol payload undefined');
    return payload;
  });
}

const model = BannedIp as unknown as ModelRuntime;

describe('BannedIp model — row shape (#200/#201)', () => {
  it('declares the documented columns', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining(['cidr', 'ipVersion', 'scope', 'reason', 'expiresAt', 'createdBy']),
    );
  });

  it('uses `cidr` as the sole identifier so the wafSync Lambda can fetch by PK', () => {
    expect(model.data.identifier).toEqual(['cidr']);
  });

  it('marks cidr as a required string (the identifier must always be present)', () => {
    expect(model.data.fields.cidr?.data?.fieldType).toBe('String');
    expect(model.data.fields.cidr?.data?.required).toBe(true);
  });
});

describe('BannedIp model — authorization (#200/#201)', () => {
  const rules = authzRules(BannedIp);
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('has NO guest/public read rule (ban lists are sensitive)', () => {
    const publicRules = rules.filter((r) => r.strategy === 'public');
    expect(publicRules).toHaveLength(0);
  });

  it('restricts every operation to the admin group ONLY', () => {
    expect(rules).toHaveLength(1);
    expect(rules[0]?.strategy).toBe('groups');
    expect(rules[0]?.groups).toEqual(['admin']);
    expect(rules[0]?.operations).toEqual(
      expect.arrayContaining(['read', 'create', 'update', 'delete']),
    );
  });

  it('grants the admin group the write surface', () => {
    const writers = rules.filter(hasAnyWrite);
    expect(writers).toHaveLength(1);
    expect(writers[0]?.strategy).toBe('groups');
    expect(writers[0]?.groups).toEqual(['admin']);
  });
});
