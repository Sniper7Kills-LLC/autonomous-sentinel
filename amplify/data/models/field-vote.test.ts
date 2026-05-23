import { describe, it, expect } from 'vitest';
import { FieldVote, castFieldVote } from './field-vote';

type AuthzRule = {
  strategy: string;
  operations?: string[];
  groupOrOwnerField?: string;
  identityClaim?: string;
  groups?: string[];
};

function authzRules(model: unknown): AuthzRule[] {
  const surface = model as { data: { authorization: readonly object[] } };
  return surface.data.authorization.map((rule): AuthzRule => {
    const symbols = Object.getOwnPropertySymbols(rule);
    const sym = symbols[0];
    if (sym === undefined) {
      throw new Error('Authorization rule missing internal symbol payload');
    }
    const indexed = rule as { [k: symbol]: AuthzRule | undefined };
    const payload = indexed[sym];
    if (payload === undefined) {
      throw new Error('Authorization rule symbol payload was undefined');
    }
    return payload;
  });
}

/**
 * Schema-shape tests for FieldVote and its companion `castFieldVote`
 * mutation (#266).
 *
 * Background: PR #257 declared `.identifier(['messageId', 'field', 'voterId'])`
 * with `field: a.enum([...])`. Amplify Gen 2 rejects nullable enum columns in
 * a composite identifier — `EnumType` has no `.required()` modifier, so the
 * identifier was structurally invalid. The decision recorded on #266
 * (option 3) is:
 *
 *   - Introduce a synthesised composite PK column
 *     `fieldKey: a.string().required()` formatted
 *     `<messageId>#<field>#<voterId>` and use that as the identifier.
 *   - Keep `field` as an `a.enum(...)` column so semantic queries + type
 *     safety stay intact.
 *   - Provide a secondary index on `(messageId, field, voterId)` so the
 *     "all votes for a message + field" aggregate query stays fast.
 *   - Synthesize the composite PK server-side via a custom mutation
 *     resolver (`castFieldVote`) — clients never compose the key.
 *
 * Tests here pin those structural decisions so a future refactor can't
 * silently regress the identifier shape or drop the enum.
 */

interface ModelRuntime {
  data: {
    identifier: readonly string[];
    fields: Record<string, FieldRuntime>;
    secondaryIndexes: readonly IndexRuntime[];
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

interface OperationRuntime {
  data: {
    typeName: 'Query' | 'Mutation' | 'Subscription' | 'Generation';
    arguments: Record<string, FieldRuntime>;
    returnType: {
      data?: { link?: string; type?: string; fieldType?: string };
    };
    authorization: readonly object[];
    handlers: readonly object[];
  };
}

const model = FieldVote as unknown as ModelRuntime;
const castOp = castFieldVote as unknown as OperationRuntime;

describe('FieldVote model identifier (issue #266)', () => {
  it('uses the synthesised composite key as its sole identifier', () => {
    // Composite-PK uniqueness moves to `fieldKey`; the enum no longer
    // participates structurally so the transform stops rejecting it.
    expect(model.data.identifier).toEqual(['fieldKey']);
  });

  it('declares fieldKey as a required string column', () => {
    const fieldKey = model.data.fields.fieldKey;
    expect(fieldKey).toBeDefined();
    expect(fieldKey?.data?.fieldType).toBe('String');
    expect(fieldKey?.data?.required).toBe(true);
  });

  it('references the shared `FieldVoteField` enum so the column + castFieldVote argument stay in lockstep (#310)', () => {
    // Switched from an inline `a.enum([...])` to `a.ref('FieldVoteField')`
    // to fix the duplicate-enum SchemaValidationError surfaced at synth
    // (the named enum is already registered on the schema for
    // castFieldVote's argument). The column must now be a required ref
    // pointing at that named enum — the runtime field record carries
    // `type: 'ref'` + `link: 'FieldVoteField'` + `valueRequired: true`.
    const field = model.data.fields.field as
      | { data?: { type?: string; link?: string; valueRequired?: boolean } }
      | undefined;
    expect(field).toBeDefined();
    expect(field?.data?.type).toBe('ref');
    expect(field?.data?.link).toBe('FieldVoteField');
    expect(field?.data?.valueRequired).toBe(true);
  });

  it('keeps messageId / voterId as required id columns', () => {
    expect(model.data.fields.messageId?.data?.fieldType).toBe('ID');
    expect(model.data.fields.messageId?.data?.required).toBe(true);
    expect(model.data.fields.voterId?.data?.fieldType).toBe('ID');
    expect(model.data.fields.voterId?.data?.required).toBe(true);
  });

  it('exposes a (messageId, field, voterId) secondary index for aggregate lookups', () => {
    // The public aggregate query ("how many votes per value on message M's
    // sender field?") needs to scan votes by (messageId, field). Sort key
    // also threads voterId so the per-user dedupe stays cheap.
    const indexes = model.data.secondaryIndexes;
    expect(Array.isArray(indexes)).toBe(true);
    const idx = indexes.find((i) => i.data.partitionKey === 'messageId');
    expect(idx).toBeDefined();
    expect(idx?.data.sortKeys).toEqual(['field', 'voterId']);
  });
});

describe('FieldVote authorization (review-fix: castFieldVote is sole write path)', () => {
  it('does not grant `create` to authenticated callers', () => {
    // The auto-generated `createFieldVote` mutation would accept a
    // client-supplied `voterId` argument and silently bypass the
    // `ctx.identity.sub` derivation in `castFieldVote`. Dropping
    // `create` from the authenticated rule closes that forgery path.
    const authenticated = authzRules(FieldVote).filter(
      (r) => r.strategy === 'public' || r.strategy === 'private',
    );
    for (const rule of authenticated) {
      expect(rule.operations).not.toContain('create');
    }
  });

  it('authenticated callers still get `read`', () => {
    const authenticated = authzRules(FieldVote).filter(
      (r) => r.strategy === 'public' || r.strategy === 'private',
    );
    const hasRead = authenticated.some((r) => r.operations?.includes('read'));
    expect(hasRead).toBe(true);
  });

  it('does NOT grant any owner-side write op (#312 — castFieldVote is the only write path)', () => {
    // Owner-side `update` / `delete` would expose the auto-generated
    // `updateFieldVote` / `deleteFieldVote` mutations. A voter could
    // then bypass `castFieldVote`'s `weightAtVoteTime` if_not_exists
    // snapshot (#33) by directly UpdateItem-ing their own row to
    // re-stamp the weight, and the cast-resolver's `voterId-from-
    // ctx.identity.sub` invariant (#259) would not protect against
    // a self-targeted update (the row's owner sub already matches
    // the caller's). Drop owner-write entirely so the cast resolver
    // is the sole authoritative write surface.
    const writeOps = new Set(['create', 'update', 'delete']);
    const owners = authzRules(FieldVote).filter((r) => r.strategy === 'owner');
    for (const owner of owners) {
      const hasWrite = (owner.operations ?? []).some((op) => writeOps.has(op));
      expect(hasWrite).toBe(false);
    }
  });
});

describe('castFieldVote custom mutation (issue #266)', () => {
  it('is a GraphQL mutation', () => {
    expect(castOp.data.typeName).toBe('Mutation');
  });

  it('takes messageId + field enum + value as required arguments', () => {
    const args = castOp.data.arguments;
    expect(args.messageId?.data?.fieldType).toBe('ID');
    expect(args.messageId?.data?.required).toBe(true);
    // `field` is a ref to the FieldVoteField enum so the same enum values
    // gate both the model column and the mutation argument. Refs don't
    // surface `data.required` on the runtime shape the way scalars do
    // (matches the `suppressEmail.reason` ref pattern), so we just pin
    // that the arg is present and the ref resolves.
    expect(args.field).toBeDefined();
    expect(args.value?.data?.fieldType).toBe('String');
    expect(args.value?.data?.required).toBe(true);
  });

  it('returns the FieldVote row that was upserted', () => {
    const ret = castOp.data.returnType;
    expect(ret).toBeDefined();
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('FieldVote');
  });

  it('wires the two-step JS resolver pipeline (#33 weight-snapshot)', () => {
    // Step 1: lookup-voter-reputation (Reputation data source);
    // Step 2: cast-field-vote (FieldVote data source). The runtime
    // resolves `ctx.prev.result.computedWeight` from step 1's
    // GetItem into step 2's UpdateItem.
    const handlers = castOp.data.handlers;
    expect(handlers).toHaveLength(2);
  });
});
