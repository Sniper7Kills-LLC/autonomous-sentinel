import { describe, it, expect } from 'vitest';
import { Sdr, listSdrPublic } from './sdr';

/**
 * Schema-shape tests for the `listSdrPublic` custom query (#286).
 * Pins authz scope (guest + authenticated), return type (Sdr ref
 * array), and handler wiring (Lambda). Resolver behaviour lives in
 * `../../functions/listSdrPublicLambda/handler.test.ts`.
 */

interface OperationRuntime {
  data: {
    typeName: 'Query' | 'Mutation' | 'Subscription';
    arguments: Record<string, FieldRuntime>;
    returnType: { data?: { link?: string; type?: string; array?: boolean } };
    authorization: readonly AuthRuntime[];
    handlers: readonly HandlerRuntime[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean };
}

interface ModelRuntime {
  data: { fields: Record<string, FieldRuntime>; authorization: readonly AuthRuntime[] };
}

type HandlerRuntime = Record<symbol, unknown>;
type AuthRuntime = Record<symbol, unknown>;

interface AuthData {
  strategy: string;
  groups?: readonly string[];
}

interface CustomHandlerData {
  handler?: unknown;
}

function symbolData<T>(obj: object): T {
  const target = obj as Record<symbol, unknown>;
  const sym = Object.getOwnPropertySymbols(target).find(
    (s) => s.description?.toLowerCase() === 'data',
  );
  if (!sym) throw new Error('no Symbol(data) on object');
  return target[sym] as T;
}

const sdrModel = Sdr as unknown as ModelRuntime;
const listOp = listSdrPublic as unknown as OperationRuntime;

describe('Sdr model — secondary index for ownerId fan-out (#286)', () => {
  it('keeps the ownerId / publicVisible / locationGranularity columns on the row shape', () => {
    const fields = Object.keys(sdrModel.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'ownerId',
        'publicVisible',
        'locationGranularity',
        'latitude',
        'longitude',
        'notes',
        'name',
      ]),
    );
  });
});

describe('listSdrPublic query (#286)', () => {
  it('is a GraphQL query', () => {
    expect(listOp.data.typeName).toBe('Query');
  });

  it('takes no arguments — server-side filter does the work', () => {
    expect(Object.keys(listOp.data.arguments)).toEqual([]);
  });

  it('returns an array of Sdr refs', () => {
    const ret = listOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('Sdr');
    expect(ret.data?.array).toBe(true);
  });

  it('is callable by guests + authenticated users (no role gate beyond Cognito-group sweep)', () => {
    const auth = listOp.data.authorization;
    expect(auth.length).toBeGreaterThanOrEqual(2);
    const rules = auth.map((a) => symbolData<AuthData>(a as object));
    expect(rules.some((r) => r.strategy === 'public')).toBe(true);
    expect(rules.some((r) => r.strategy === 'private')).toBe(true);
    // Per #430: every named Cognito group is enumerated alongside the
    // `private` rule so signed-in users in a group reach the query
    // through their per-group IAM role.
    const sweep = rules.find(
      (r) =>
        r.strategy === 'groups' &&
        (r.groups ?? []).includes('admin') &&
        (r.groups ?? []).includes('moderator') &&
        (r.groups ?? []).includes('member'),
    );
    expect(sweep).toBeDefined();
  });

  it('wires the listSdrPublicLambda as the handler', () => {
    const handlers = listOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});
