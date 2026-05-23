import { describe, it, expect } from 'vitest';
import { LinguisticConfig } from './linguistic-config';

/**
 * Schema-shape tests for the LinguisticConfig model (#43).
 *
 * Pins the runtime-config contract documented in the issue:
 *   - `key` is the identifier (e.g. SKYKING_RULES,
 *     CONFIDENCE_THRESHOLD_SKYKING, *_PROMPT_VERSION).
 *   - `value` is required JSON so any rule / schema / threshold
 *     shape can be stored without a model migration.
 *   - `promptVersion` integer + GSI so the reprocess-on-bump trigger
 *     (deferred to phase 3) can find every key with a given version
 *     cheaply.
 *   - Authz: admin-only read / write (no public surface — the
 *     Linguistic Logic Lambda reads via IAM role, not a public
 *     query).
 *
 * Revision history is captured by AuditLog (#38), not a per-key
 * history table — see comment in `linguistic-config.ts`.
 */

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime | undefined>;
    authorization: readonly AuthRuntime[];
    secondaryIndexes: readonly IndexRuntime[];
    identifier: readonly string[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean };
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

const model = LinguisticConfig as unknown as ModelRuntime;

describe('LinguisticConfig model — row shape (#43)', () => {
  it('declares the documented columns', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining(['key', 'value', 'promptVersion', 'activeAt', 'createdById', 'notes']),
    );
  });

  it('uses `key` as the sole identifier so the Lambda can lookup-by-key', () => {
    expect(model.data.identifier).toEqual(['key']);
  });

  it('marks `key` + `value` as required (no half-published config rows)', () => {
    expect(model.data.fields.key?.data?.fieldType).toBe('String');
    expect(model.data.fields.key?.data?.required).toBe(true);
    expect(model.data.fields.value?.data?.fieldType).toBe('AWSJSON');
    expect(model.data.fields.value?.data?.required).toBe(true);
  });

  it('keeps `promptVersion` as an optional integer so the reprocess trigger can query by version', () => {
    expect(model.data.fields.promptVersion?.data?.fieldType).toBe('Int');
    expect(model.data.fields.promptVersion?.data?.required).toBeFalsy();
  });
});

describe('LinguisticConfig model — secondary indexes (#43)', () => {
  it('indexes by `promptVersion` so the reprocess-on-bump trigger can scan keys by version cheaply', () => {
    const idx = model.data.secondaryIndexes.find((i) => i.data.partitionKey === 'promptVersion');
    expect(idx).toBeDefined();
  });
});

describe('LinguisticConfig model — authorization (#43)', () => {
  const rules = authzRules(LinguisticConfig);
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('exposes NO public / authenticated read — Lambda reads via IAM role, not via AppSync', () => {
    const publicOrAuth = rules.filter((r) => r.strategy === 'public' || r.strategy === 'private');
    expect(publicOrAuth).toEqual([]);
  });

  it('grants admins full CRUD (sole authz rule on the model)', () => {
    const admin = rules.find((r) => r.strategy === 'groups' && (r.groups ?? []).includes('admin'));
    expect(admin).toBeDefined();
    expect(admin?.operations).toEqual(
      expect.arrayContaining(['read', 'create', 'update', 'delete']),
    );
  });

  it('no other authz rule exists (admin is the only writer + reader)', () => {
    const writers = rules.filter(hasAnyWrite);
    expect(writers).toHaveLength(1);
    expect(writers[0]?.strategy).toBe('groups');
    expect(writers[0]?.groups).toEqual(['admin']);
  });
});
