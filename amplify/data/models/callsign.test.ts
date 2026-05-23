import { describe, it, expect } from 'vitest';
import { Callsign } from './callsign';

/**
 * Schema-shape tests for the Callsign model (#39).
 *
 * Pins the dictionary row shape + authz contract from the issue body:
 *   - Public typeahead read.
 *   - Admin-only writes (create / update / delete).
 *   - AI-suggested entries default to `approved=true` at the model
 *     level — the AI-merge pipeline (phase 7 #136) overrides to
 *     `approved=false` when it lands; this test pins the default.
 *   - Source enum covers LEGACY (seed), ADMIN (manual), AI_SUGGESTED.
 *   - Variants array carries the spelling alternates.
 *   - Secondary index on `source` so the admin "pending review"
 *     queue can list AI_SUGGESTED entries cheaply.
 */

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime | undefined>;
    authorization: readonly AuthRuntime[];
    secondaryIndexes: readonly IndexRuntime[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean; array?: boolean; default?: unknown };
  type?: string;
  values?: readonly string[];
}

function defaultValue(field: FieldRuntime | undefined): unknown {
  return field?.data?.default;
}

interface IndexRuntime {
  data: { partitionKey: string };
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

const model = Callsign as unknown as ModelRuntime;

describe('Callsign model — row shape (#39)', () => {
  it('declares the documented columns', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'normalized',
        'variants',
        'source',
        'confidence',
        'approved',
        'notes',
      ]),
    );
  });

  it('marks `normalized` as a required string', () => {
    expect(model.data.fields.normalized?.data?.fieldType).toBe('String');
    expect(model.data.fields.normalized?.data?.required).toBe(true);
  });

  it('models `variants` as an array of strings (spelling alternates)', () => {
    const f = model.data.fields.variants?.data;
    expect(f?.fieldType).toBe('String');
    expect(f?.array).toBe(true);
  });

  it('uses an enum for `source` (LEGACY / ADMIN / AI_SUGGESTED)', () => {
    const f = model.data.fields.source;
    expect(f?.type).toBe('enum');
    expect(f?.values).toEqual(['LEGACY', 'ADMIN', 'AI_SUGGESTED']);
  });

  it('keeps `confidence` as an optional float for AI-suggested entries', () => {
    expect(model.data.fields.confidence?.data?.fieldType).toBe('Float');
    expect(model.data.fields.confidence?.data?.required).toBeFalsy();
  });

  it('defaults `approved` to true; AI pipeline overrides to false on suggestion (#136)', () => {
    expect(model.data.fields.approved?.data?.fieldType).toBe('Boolean');
    // CDK runtime stores defaults under `data.default` — both
    // render the same boolean in the CFN template regardless of
    // Amplify Gen 2 minor version. Pin presence + truthy.
    expect(defaultValue(model.data.fields.approved)).toBe(true);
  });
});

describe('Callsign model — secondary indexes (#39)', () => {
  it('indexes by `source` so the admin pending-review queue lists AI_SUGGESTED cheaply', () => {
    const idx = model.data.secondaryIndexes.find((i) => i.data.partitionKey === 'source');
    expect(idx).toBeDefined();
  });
});

describe('Callsign model — authorization (#39)', () => {
  const rules = authzRules(Callsign);
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('grants public (guest) read for typeahead — exactly one rule, read-only', () => {
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
