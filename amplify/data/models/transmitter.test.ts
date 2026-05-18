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

  it('models frequencyKhzList as an integer array (curated kHz frequencies)', () => {
    const f = model.data.fields.frequencyKhzList?.data;
    expect(f?.array).toBe(true);
    // Field type is the Amplify Gen 2 scalar name; tolerate any
    // integer alias the runtime uses ('integer' / 'int' depending on
    // SDK version).
    expect(f?.fieldType?.toLowerCase()).toMatch(/integer|int/);
  });
});

describe('Transmitter model — authorization', () => {
  const rules = model.data.authorization.map((r) => symbolData<AuthData>(r as object));

  it('grants public (guest) read', () => {
    const guestRead = rules.find(
      (r) => r.strategy === 'public' && (r.operations ?? []).includes('read'),
    );
    expect(guestRead).toBeDefined();
  });

  it('restricts create / update / delete to the admin group only', () => {
    const adminAll = rules.find(
      (r) =>
        r.strategy === 'groups' &&
        (r.groups ?? []).includes('admin') &&
        (r.operations ?? []).includes('create') &&
        (r.operations ?? []).includes('update') &&
        (r.operations ?? []).includes('delete'),
    );
    expect(adminAll).toBeDefined();
  });

  it('does NOT grant create / update / delete to authenticated callers (non-admin write rejected)', () => {
    const authWriter = rules.find(
      (r) =>
        r.strategy === 'private' &&
        ((r.operations ?? []).includes('create') ||
          (r.operations ?? []).includes('update') ||
          (r.operations ?? []).includes('delete')),
    );
    expect(authWriter).toBeUndefined();
  });

  it('does NOT grant create / update / delete to the moderator group (admin-only write)', () => {
    const modWriter = rules.find(
      (r) =>
        r.strategy === 'groups' &&
        (r.groups ?? []).includes('moderator') &&
        ((r.operations ?? []).includes('create') ||
          (r.operations ?? []).includes('update') ||
          (r.operations ?? []).includes('delete')),
    );
    expect(modWriter).toBeUndefined();
  });
});
