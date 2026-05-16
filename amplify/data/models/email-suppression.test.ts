import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmailSuppression, suppressEmail, isSuppressed } from './email-suppression';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Schema-shape tests for the EmailSuppression model (#249) and its two
 * custom operations: `suppressEmail` (upsert) and `isSuppressed` (lookup).
 *
 * The model is admin-only by design — the bounce/complaint Lambda (#250)
 * will call these mutations from a Lambda-assumed admin role. These tests
 * pin the schema shape so refactors can't silently widen authz or drop
 * fields the SES handler depends on.
 *
 * Resolver-logic tests live alongside their resolver source under
 * ./resolvers/ — they exercise the JS `request` / `response` functions
 * directly with mock AppSync contexts.
 */

// Loose runtime shapes for the amplify-data-schema builders. The public
// types expose only the chainable builder API; runtime introspection
// reads through `.data` (and a `Symbol('data')`-keyed payload on auth
// rules + custom-handler configs).

interface ModelRuntime {
  data: {
    identifier: readonly string[];
    fields: Record<string, FieldRuntime>;
    secondaryIndexes: readonly IndexRuntime[];
    authorization: readonly AuthRuntime[];
  };
}

interface FieldRuntime {
  type?: string;
  values?: readonly string[];
  data?: {
    fieldType?: string;
    required?: boolean;
  };
}

interface IndexRuntime {
  data: {
    partitionKey: string;
    sortKeys: readonly string[];
  };
}

interface AuthRuntime {
  // The actual authz payload is on a Symbol('data') key; see symbolData.
  [k: string]: unknown;
}

interface OperationRuntime {
  data: {
    typeName: 'Query' | 'Mutation' | 'Subscription' | 'Generation';
    arguments: Record<string, FieldRuntime>;
    returnType: {
      data?: { link?: string; type?: string; fieldType?: string };
    };
    authorization: readonly AuthRuntime[];
    handlers: readonly HandlerRuntime[];
  };
}

type HandlerRuntime = Record<symbol, unknown>;

interface AuthData {
  strategy: string;
  groups?: readonly string[];
  operations?: readonly string[];
}

interface CustomHandlerData {
  entry: string;
  dataSource?: unknown;
}

/**
 * Pull the value stashed under a `Symbol('data')` / `Symbol('Data')` key.
 * The data-schema builders use a non-enumerable symbol so the public
 * builder API stays minimal; runtime introspection needs the symbol.
 */
function symbolData<T>(obj: object): T {
  const target = obj as Record<symbol, unknown>;
  const sym = Object.getOwnPropertySymbols(target).find(
    (s) => s.description?.toLowerCase() === 'data',
  );
  if (!sym) throw new Error('no Symbol(data) on object');
  return target[sym] as T;
}

const model = EmailSuppression as unknown as ModelRuntime;
const suppressOp = suppressEmail as unknown as OperationRuntime;
const isSuppressedOp = isSuppressed as unknown as OperationRuntime;

describe('EmailSuppression model (issue #249)', () => {
  it('uses email as the partition key (one row per address)', () => {
    expect(model.data.identifier).toEqual(['email']);
  });

  it('exposes the suppression-reason enum required by SES handling', () => {
    const reason = model.data.fields.reason;
    expect(reason).toBeDefined();
    expect(reason?.type).toBe('enum');
    expect(reason?.values).toEqual(['HARD_BOUNCE', 'SOFT_BOUNCE_REPEATED', 'COMPLAINT', 'MANUAL']);
  });

  it('declares email + bounceType + timestamps + occurrences + notes fields', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'email',
        'reason',
        'bounceType',
        'firstSeenAt',
        'lastSeenAt',
        'occurrences',
        'notes',
      ]),
    );
    expect(model.data.fields.email?.data?.required).toBe(true);
    expect(model.data.fields.email?.data?.fieldType).toBe('String');
  });

  it('indexes by reason sorted by lastSeenAt (admin "recent COMPLAINTs" query)', () => {
    const indexes = model.data.secondaryIndexes;
    expect(Array.isArray(indexes)).toBe(true);
    const reasonIndex = indexes.find((i) => i.data.partitionKey === 'reason');
    expect(reasonIndex).toBeDefined();
    expect(reasonIndex?.data.sortKeys).toEqual(['lastSeenAt']);
  });

  it('is admin-only (read + create + update + delete)', () => {
    const auth = model.data.authorization;
    expect(auth).toHaveLength(1);
    const rule = symbolData<AuthData>(auth[0] as object);
    expect(rule.strategy).toBe('groups');
    expect(rule.groups).toEqual(['admin']);
    expect(rule.operations).toEqual(['read', 'create', 'update', 'delete']);
  });
});

describe('suppressEmail custom mutation (issue #249)', () => {
  it('is a GraphQL mutation', () => {
    expect(suppressOp.data.typeName).toBe('Mutation');
  });

  it('takes email + reason and optional bounceType + notes', () => {
    const args = suppressOp.data.arguments;
    expect(args.email).toBeDefined();
    expect(args.email?.data?.fieldType).toBe('String');
    expect(args.email?.data?.required).toBe(true);
    expect(args.reason).toBeDefined();
    expect(args.bounceType).toBeDefined();
    expect(args.notes).toBeDefined();
  });

  it('returns the EmailSuppression row that was written', () => {
    const ret = suppressOp.data.returnType;
    expect(ret).toBeDefined();
    // a.ref('EmailSuppression') — return is a ref-type linking to the model
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('EmailSuppression');
  });

  it('is admin-only (Lambda assumes admin role; no public callers)', () => {
    const auth = suppressOp.data.authorization;
    expect(auth).toHaveLength(1);
    const rule = symbolData<AuthData>(auth[0] as object);
    expect(rule.strategy).toBe('groups');
    expect(rule.groups).toEqual(['admin']);
  });

  it('wires a custom JS resolver bound to the EmailSuppression data source', () => {
    const handlers = suppressOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.entry).toMatch(/suppress-email/);
    expect(cfg.dataSource).toBeDefined();
    const absolute = resolve(here, cfg.entry);
    expect(existsSync(absolute)).toBe(true);
  });
});

describe('isSuppressed custom query (issue #249)', () => {
  it('is a GraphQL query', () => {
    expect(isSuppressedOp.data.typeName).toBe('Query');
  });

  it('takes a single required email argument', () => {
    const args = isSuppressedOp.data.arguments;
    expect(Object.keys(args)).toEqual(['email']);
    expect(args.email?.data?.fieldType).toBe('String');
    expect(args.email?.data?.required).toBe(true);
  });

  it('returns a boolean (caller just needs yes/no)', () => {
    const ret = isSuppressedOp.data.returnType;
    expect(ret.data?.fieldType).toBe('Boolean');
  });

  it('is admin-only (email-send Lambda calls it with admin creds)', () => {
    const auth = isSuppressedOp.data.authorization;
    expect(auth).toHaveLength(1);
    const rule = symbolData<AuthData>(auth[0] as object);
    expect(rule.strategy).toBe('groups');
    expect(rule.groups).toEqual(['admin']);
  });

  it('wires a custom JS resolver bound to the EmailSuppression data source', () => {
    const handlers = isSuppressedOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.entry).toMatch(/is-suppressed/);
    expect(cfg.dataSource).toBeDefined();
    const absolute = resolve(here, cfg.entry);
    expect(existsSync(absolute)).toBe(true);
  });
});
