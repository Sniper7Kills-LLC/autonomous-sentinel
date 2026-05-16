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

  it('keeps `field` as the enum column so semantic queries stay typed', () => {
    const field = model.data.fields.field;
    expect(field).toBeDefined();
    expect(field?.type).toBe('enum');
    expect(field?.values).toEqual(['SENDER', 'RECEIVER', 'BODY', 'TYPE']);
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

  it('owner rule (voterId) still owns update + delete', () => {
    const owner = authzRules(FieldVote).find((r) => r.strategy === 'owner');
    expect(owner).toBeDefined();
    expect(owner?.groupOrOwnerField).toBe('voterId');
    expect(owner?.identityClaim).toBe('sub');
    expect(owner?.operations).toEqual(expect.arrayContaining(['update', 'delete']));
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

  it('wires the cast-field-vote JS resolver on the FieldVote data source', () => {
    const handlers = castOp.data.handlers;
    expect(handlers).toHaveLength(1);
  });
});
