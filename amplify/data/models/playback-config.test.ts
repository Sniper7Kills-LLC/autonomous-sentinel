import { describe, it, expect } from 'vitest';
import { PlaybackConfig } from './playback-config';

/**
 * Schema-shape tests for the PlaybackConfig model (#114).
 *
 * Pins the admin-tunable per-IP playback rate-limit contract:
 *   - `key` is the sole identifier (singleton row, e.g. "default").
 *   - Every rate-limit knob column is present + correctly typed.
 *   - Authz: admin-only read / write (these are admin knobs; no public
 *     or authenticated read surface — the signed-URL / edge enforcement
 *     reads via IAM role, not via AppSync).
 *
 * Mirrors `reputation-config.test.ts`.
 */

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime | undefined>;
    authorization: readonly AuthRuntime[];
    identifier: readonly string[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean };
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

const model = PlaybackConfig as unknown as ModelRuntime;

describe('PlaybackConfig model — row shape (#114)', () => {
  it('declares every playback rate-limit knob column', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'key',
        'requestsPerMinute',
        'bytesPerHour',
        'signedUrlTtlSeconds',
        'notes',
      ]),
    );
  });

  it('uses `key` as the sole identifier (singleton row)', () => {
    expect(model.data.identifier).toEqual(['key']);
  });

  it('marks `key` as a required string (no half-published config rows)', () => {
    expect(model.data.fields.key?.data?.fieldType).toBe('String');
    expect(model.data.fields.key?.data?.required).toBe(true);
  });

  it('types request/ttl knobs as integers and the byte budget as a float', () => {
    expect(model.data.fields.requestsPerMinute?.data?.fieldType).toBe('Int');
    expect(model.data.fields.signedUrlTtlSeconds?.data?.fieldType).toBe('Int');
    expect(model.data.fields.bytesPerHour?.data?.fieldType).toBe('Float');
  });
});

describe('PlaybackConfig model — authorization (#114)', () => {
  const rules = authzRules(PlaybackConfig);
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('exposes NO public / authenticated read — admin-only knobs', () => {
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
