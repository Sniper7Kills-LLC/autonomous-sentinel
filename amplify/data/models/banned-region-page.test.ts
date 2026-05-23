import { describe, it, expect } from 'vitest';
import { BannedRegionPage } from './banned-region-page';

/**
 * Schema-shape tests for the BannedRegionPage model (#42).
 *
 * Pins the contract documented in the issue:
 *   - `countryCode` is the identifier — one row per ISO-3166-1
 *     alpha-2 code so the WAF custom-response Lambda (phase 9) can
 *     fetch by primary key.
 *   - `title` + `bodyMarkdown` are required so a published row is
 *     always renderable.
 *   - `enabled` toggle so an admin can disable a page without
 *     deleting it.
 *   - Authz: guest read (the WAF Lambda runs as an
 *     identity-pool-unauthenticated role on the edge); admin-only
 *     writes.
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

function defaultValue(field: FieldRuntime | undefined): unknown {
  return field?.data?.default;
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
    const sym = Object.getOwnPropertySymbols(rule)[0];
    if (!sym) throw new Error('rule has no Symbol payload');
    const payload = (rule as Record<symbol, AuthData | undefined>)[sym];
    if (!payload) throw new Error('rule Symbol payload undefined');
    return payload;
  });
}

const model = BannedRegionPage as unknown as ModelRuntime;

describe('BannedRegionPage model — row shape (#42)', () => {
  it('declares the documented columns', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining(['countryCode', 'title', 'bodyMarkdown', 'enabled']),
    );
  });

  it('uses `countryCode` as the sole identifier so a WAF Lambda can fetch by PK', () => {
    expect(model.data.identifier).toEqual(['countryCode']);
  });

  it('marks countryCode + title + bodyMarkdown as required (no half-published rows)', () => {
    expect(model.data.fields.countryCode?.data?.fieldType).toBe('String');
    expect(model.data.fields.countryCode?.data?.required).toBe(true);
    expect(model.data.fields.title?.data?.required).toBe(true);
    expect(model.data.fields.bodyMarkdown?.data?.required).toBe(true);
  });

  it('defaults `enabled` to true (admin must explicitly disable to suppress)', () => {
    expect(model.data.fields.enabled?.data?.fieldType).toBe('Boolean');
    expect(defaultValue(model.data.fields.enabled)).toBe(true);
  });
});

describe('BannedRegionPage model — authorization (#42)', () => {
  const rules = authzRules(BannedRegionPage);
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('grants public (guest) read so the WAF custom-response Lambda fetches without auth', () => {
    const publicRules = rules.filter((r) => r.strategy === 'public');
    expect(publicRules).toHaveLength(1);
    expect(publicRules[0]?.operations).toContain('read');
    expect(hasAnyWrite(publicRules[0]!)).toBe(false);
  });

  it('restricts write surface to the admin group ONLY', () => {
    const writers = rules.filter(hasAnyWrite);
    expect(writers).toHaveLength(1);
    expect(writers[0]?.strategy).toBe('groups');
    expect(writers[0]?.groups).toEqual(['admin']);
    expect(writers[0]?.operations).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
  });
});
