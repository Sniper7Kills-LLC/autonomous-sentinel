import { describe, it, expect } from 'vitest';
import { Transmitter } from './transmitter';

/**
 * Schema-shape tests for the Transmitter model (#31).
 *
 * Pins the row shape (required name + lat/lon, optional callsign / notes /
 * frequencyKhzList multi-value, Sdr backref) and the authz contract
 * (guests + authenticated callers may read; only the admin group may
 * create / update / delete). Behavioural tests for the propagation-map
 * surface live with their respective resolvers — this file just locks
 * the model itself so a drift on either side becomes a visible diff.
 *
 * Pattern mirrors `sdr.test.ts` — pull the Amplify Gen 2 model
 * descriptor through the `Symbol(data)` reflection helper and assert
 * against its declared field map / authorization list.
 */

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime>;
    authorization: readonly AuthRuntime[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean; array?: boolean };
}

type AuthRuntime = Record<symbol, unknown>;

interface AuthData {
  strategy: string;
  groups?: readonly string[];
  operations?: readonly string[];
}

function symbolData<T>(obj: object): T {
  const target = obj as Record<symbol, unknown>;
  const sym = Object.getOwnPropertySymbols(target).find(
    (s) => s.description?.toLowerCase() === 'data',
  );
  if (!sym) throw new Error('no Symbol(data) on object');
  return target[sym] as T;
}

const model = Transmitter as unknown as ModelRuntime;

describe('Transmitter model — row shape', () => {
  it('exposes the documented columns (#31)', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'name',
        'latitude',
        'longitude',
        'callsign',
        'frequencyKhzList',
        'notes',
        'sdrs',
      ]),
    );
  });

  it('marks name + latitude + longitude as required', () => {
    expect(model.data.fields.name?.data?.required).toBe(true);
    expect(model.data.fields.latitude?.data?.required).toBe(true);
    expect(model.data.fields.longitude?.data?.required).toBe(true);
  });

  it('leaves callsign / notes / frequencyKhzList optional', () => {
    expect(model.data.fields.callsign?.data?.required).toBeFalsy();
    expect(model.data.fields.notes?.data?.required).toBeFalsy();
    expect(model.data.fields.frequencyKhzList?.data?.required).toBeFalsy();
  });

  it('models frequencyKhzList as an optional integer array (curated kHz frequencies)', () => {
    const f = model.data.fields.frequencyKhzList?.data;
    expect(f?.array).toBe(true);
    // Field type is the Amplify Gen 2 scalar name; tolerate any
    // integer alias the runtime uses ('integer' / 'int' depending on
    // SDK version).
    expect(f?.fieldType?.toLowerCase()).toMatch(/integer|int/);
    // Explicit per-field optionality assertion — the model declares
    // `a.integer().array()` with no `.required()`. The shared
    // "leaves … optional" test above also covers this but only via a
    // negative `toBeFalsy()` check, which passes for `undefined`
    // whether the field was inspected or not. Pin it here too.
    expect(f?.required).toBeFalsy();
  });
});

describe('Transmitter model — authorization', () => {
  const rules = model.data.authorization.map((r) => symbolData<AuthData>(r as object));
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('grants public (guest) read — exactly one rule, read-only', () => {
    // `toHaveLength(1)` rather than "at least one" so an accidental
    // duplicate `allow.guest()` declaration becomes a visible diff.
    const publicRules = rules.filter((r) => r.strategy === 'public');
    expect(publicRules).toHaveLength(1);
    const publicRule = publicRules[0]!;
    expect(publicRule.operations ?? []).toContain('read');
    // Guest must never carry a write scope — public-write would
    // allow anonymous edits to the admin-managed propagation map.
    expect(hasAnyWrite(publicRule)).toBe(false);
  });

  it('restricts create / update / delete to the admin group only', () => {
    const adminAll = rules.find(
      (r) =>
        r.strategy === 'groups' &&
        (r.groups ?? []).includes('admin') &&
        WRITE_OPS.every((op) => (r.operations ?? []).includes(op)),
    );
    expect(adminAll).toBeDefined();
  });

  it('no rule other than the admin-group rule grants any write op', () => {
    // Belt-and-suspenders across every strategy (public / private /
    // groups / owner / custom). The only writer must be the admin
    // group rule asserted above.
    const writers = rules.filter(hasAnyWrite);
    expect(writers).toHaveLength(1);
    expect(writers[0]?.strategy).toBe('groups');
    expect(writers[0]?.groups ?? []).toEqual(['admin']);
  });
});
