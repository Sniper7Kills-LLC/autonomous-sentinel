import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { User, selfDelete, banUser, getUserPublic } from './user';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Schema-shape tests for the User custom operations added in #248:
 *   - `selfDelete` mutation (caller blanks own PII)
 *   - `banUser` mutation (admin sets bannedAt/Reason/ById on a target)
 *   - `getUserPublic` query (PII-filter wrapper around GetItem)
 *
 * The point of these tests is to pin schema-level invariants — the
 * authorization scopes, the argument lists, the return types, the
 * handler wiring — so refactors can't accidentally widen the public
 * surface (e.g. by dropping the admin-only guard on `banUser`) or
 * leave the resolver pointing at a missing file.
 *
 * Resolver / handler behavior lives in the dedicated tests:
 *   - JS resolver — ./resolvers/get-user-public.test.ts
 *   - Lambda handler — ../../functions/userMutations/handler.test.ts
 */

// Loose runtime shapes mirroring the email-suppression tests — the
// amplify-data-schema builders stash their config on a Symbol('data')
// key, so we introspect through known shapes rather than `as any`.

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime>;
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

interface AuthRuntime {
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
  resource?: unknown;
}

interface CustomHandlerData {
  entry?: string;
  dataSource?: unknown;
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

const userModel = User as unknown as ModelRuntime;
const selfDeleteOp = selfDelete as unknown as OperationRuntime;
const banUserOp = banUser as unknown as OperationRuntime;
const getUserPublicOp = getUserPublic as unknown as OperationRuntime;

describe('User model — legacy claim lookup (issue #248)', () => {
  /**
   * Acceptance criterion: "Legacy claim lookup by legacyEmail returns
   * the pre-seeded row." Schema-level guarantee — the `i('legacyEmail')`
   * secondary index from #257 generates a `listUserByLegacyEmail`
   * GraphQL operation. Verify the index is present.
   */
  interface ModelRuntimeWithIndexes extends ModelRuntime {
    data: {
      fields: Record<string, FieldRuntime>;
      authorization: readonly AuthRuntime[];
      secondaryIndexes: readonly { data: { partitionKey: string } }[];
    };
  }

  const m = User as unknown as ModelRuntimeWithIndexes;

  it('has a GSI on legacyEmail for the claim lookup', () => {
    const idx = m.data.secondaryIndexes.find((i) => i.data.partitionKey === 'legacyEmail');
    expect(idx).toBeDefined();
  });

  it('has a GSI on legacyUserId for migration tooling', () => {
    const idx = m.data.secondaryIndexes.find((i) => i.data.partitionKey === 'legacyUserId');
    expect(idx).toBeDefined();
  });

  it('has a GSI on email for the post-confirmation lookup', () => {
    const idx = m.data.secondaryIndexes.find((i) => i.data.partitionKey === 'email');
    expect(idx).toBeDefined();
  });
});

describe('User model — direct read scope (issue #248)', () => {
  it('still owns the PII-bearing fields (email, preferredUsername, displayName)', () => {
    const fields = Object.keys(userModel.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'cognitoSub',
        'email',
        'preferredUsername',
        'displayName',
        'piiBlanked',
        'piiBlankedAt',
        'bannedAt',
        'bannedReason',
        'bannedById',
      ]),
    );
  });

  it('restricts direct model reads to admin + moderator (review fix — #248)', () => {
    // Reviewer flagged that broad guest/authenticated reads on User
    // bypassed the `getUserPublic` PII filter. The model is now read-
    // restricted to mod + admin groups; the public read surface is
    // `getUserPublic` (PII-filtered).
    const auth = userModel.data.authorization;
    const strategies = auth.map((a) => symbolData<AuthData>(a as object).strategy);
    expect(strategies).not.toContain('public');
    expect(strategies).not.toContain('private');
    expect(strategies).toContain('groups');

    const groupRules = auth
      .map((a) => symbolData<AuthData>(a as object))
      .filter((r) => r.strategy === 'groups');
    const flatGroups = groupRules.flatMap((r) => Array.from(r.groups ?? []));
    expect(flatGroups).toEqual(expect.arrayContaining(['admin', 'moderator']));
  });

  it('drops the owner-update rule so banned users cannot self-clear their ban (review fix — #248)', () => {
    // Amplify Gen 2 model authz is row-level, not field-level — an
    // `allow.ownerDefinedIn('cognitoSub')` grant would let a banned
    // user write `bannedAt = null` via the auto-generated
    // `updateUser`. Removing the owner rule forces all User writes
    // through the custom mutations (selfDelete, banUser, +future
    // updateProfile).
    const auth = userModel.data.authorization;
    const ownerRules = auth
      .map((a) => symbolData<AuthData>(a as object))
      .filter((r) => r.strategy === 'owner');
    expect(ownerRules).toHaveLength(0);
  });
});

describe('selfDelete mutation (issue #248)', () => {
  it('is a GraphQL mutation', () => {
    expect(selfDeleteOp.data.typeName).toBe('Mutation');
  });

  it('takes no arguments — caller blanks their own row, identity from JWT', () => {
    expect(Object.keys(selfDeleteOp.data.arguments)).toEqual([]);
  });

  it('returns the updated User row (a.ref("User"))', () => {
    const ret = selfDeleteOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('User');
  });

  it('is authenticated-only (any signed-in user can blank their own row)', () => {
    const auth = selfDeleteOp.data.authorization;
    expect(auth.length).toBeGreaterThanOrEqual(1);
    const strategies = auth.map((a) => symbolData<AuthData>(a as object).strategy);
    // The runtime contract: caller must be authenticated. The Lambda
    // additionally checks identity.sub presence as defense in depth.
    expect(strategies.some((s) => s === 'private')).toBe(true);
  });

  it('wires the userMutations Lambda as the handler', () => {
    const handlers = selfDeleteOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});

describe('banUser mutation (issue #248)', () => {
  it('is a GraphQL mutation', () => {
    expect(banUserOp.data.typeName).toBe('Mutation');
  });

  it('takes targetCognitoSub + reason', () => {
    const args = banUserOp.data.arguments;
    expect(args.targetCognitoSub).toBeDefined();
    expect(args.targetCognitoSub?.data?.fieldType).toBe('String');
    expect(args.targetCognitoSub?.data?.required).toBe(true);
    expect(args.reason).toBeDefined();
    expect(args.reason?.data?.fieldType).toBe('String');
  });

  it('returns the banned User row (a.ref("User"))', () => {
    const ret = banUserOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('User');
  });

  it('is admin-only', () => {
    const auth = banUserOp.data.authorization;
    expect(auth.length).toBeGreaterThanOrEqual(1);
    const groupsRule = auth
      .map((a) => symbolData<AuthData>(a as object))
      .find((r) => r.strategy === 'groups');
    expect(groupsRule).toBeDefined();
    expect(groupsRule?.groups).toEqual(['admin']);
  });

  it('wires the userMutations Lambda as the handler', () => {
    const handlers = banUserOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});

describe('getUserPublic query (issue #248)', () => {
  it('is a GraphQL query', () => {
    expect(getUserPublicOp.data.typeName).toBe('Query');
  });

  it('takes a required cognitoSub argument', () => {
    const args = getUserPublicOp.data.arguments;
    expect(args.cognitoSub).toBeDefined();
    expect(args.cognitoSub?.data?.fieldType).toBe('String');
    expect(args.cognitoSub?.data?.required).toBe(true);
  });

  it('returns the User row (PII-filtered for non-admins)', () => {
    const ret = getUserPublicOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('User');
  });

  it('is callable by guests + authenticated users (public profile pages)', () => {
    const auth = getUserPublicOp.data.authorization;
    const strategies = auth.map((a) => symbolData<AuthData>(a as object).strategy);
    expect(strategies).toEqual(expect.arrayContaining(['public', 'private']));
  });

  it('wires the get-user-public JS resolver bound to the User data source', () => {
    const handlers = getUserPublicOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.entry).toMatch(/get-user-public/);
    expect(cfg.dataSource).toBeDefined();
    if (cfg.entry) {
      const absolute = resolve(here, cfg.entry);
      expect(existsSync(absolute)).toBe(true);
    }
  });
});
