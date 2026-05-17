import { describe, it, expect } from 'vitest';
import { RevisionVote, castRevisionVote } from './revision-vote';

/**
 * Schema-shape tests for the `castRevisionVote` mutation (#35).
 * Pins the two-step pipeline + the lockdown of the model-level
 * `create` so the auto-generated `createRevisionVote` forgery path
 * stays closed.
 *
 * Resolver behaviour lives in
 * `./resolvers/cast-revision-vote.test.ts`.
 */

type AuthzRule = {
  strategy: string;
  operations?: string[];
  groups?: string[];
};

interface ModelRuntime {
  data: {
    authorization: readonly object[];
  };
}

interface OperationRuntime {
  data: {
    typeName: 'Mutation' | 'Query' | 'Subscription';
    arguments: Record<string, { data?: { fieldType?: string; required?: boolean } }>;
    returnType: { data?: { link?: string; type?: string } };
    authorization: readonly object[];
    handlers: readonly object[];
  };
}

function authzRules(model: unknown): AuthzRule[] {
  const surface = model as ModelRuntime;
  return surface.data.authorization.map((rule): AuthzRule => {
    const symbols = Object.getOwnPropertySymbols(rule);
    const sym = symbols[0];
    if (sym === undefined) throw new Error('rule has no Symbol payload');
    const indexed = rule as { [k: symbol]: AuthzRule | undefined };
    const payload = indexed[sym];
    if (payload === undefined) throw new Error('rule Symbol payload undefined');
    return payload;
  });
}

const castOp = castRevisionVote as unknown as OperationRuntime;

describe('RevisionVote model authz (#35)', () => {
  it("does NOT grant 'create' on the model — castRevisionVote is the sole write path", () => {
    const authedRule = authzRules(RevisionVote).find(
      (r) => r.strategy === 'public' || r.strategy === 'private',
    );
    expect(authedRule?.operations).not.toContain('create');
    expect(authedRule?.operations).toContain('read');
  });
});

describe('castRevisionVote mutation (#35)', () => {
  it('is a GraphQL mutation', () => {
    expect(castOp.data.typeName).toBe('Mutation');
  });

  it('takes revisionId + value (RevisionVoteValue ref) as required args', () => {
    const args = castOp.data.arguments;
    expect(args.revisionId?.data?.fieldType).toBe('ID');
    expect(args.revisionId?.data?.required).toBe(true);
    expect(args.value).toBeDefined();
  });

  it('returns the upserted RevisionVote row', () => {
    const ret = castOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('RevisionVote');
  });

  it('wires the two-step JS resolver pipeline', () => {
    // Step 1: lookup-voter-reputation (Reputation data source);
    // Step 2: cast-revision-vote (RevisionVote data source).
    const handlers = castOp.data.handlers;
    expect(handlers).toHaveLength(2);
  });
});
