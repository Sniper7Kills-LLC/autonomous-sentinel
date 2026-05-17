import { describe, it, expect } from 'vitest';
import { Comment, createComment, softDeleteComment } from './comment';

/**
 * Schema-shape tests for the Comment custom mutations (#32).
 * Pins authz scope, arguments, return types, and handler wiring.
 *
 * Resolver behaviour lives in
 * `../../functions/commentMutations/handler.test.ts`.
 */

interface OperationRuntime {
  data: {
    typeName: 'Query' | 'Mutation' | 'Subscription';
    arguments: Record<string, FieldRuntime>;
    returnType: { data?: { link?: string; type?: string } };
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
  operations?: readonly string[];
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

const commentModel = Comment as unknown as ModelRuntime;
const createOp = createComment as unknown as OperationRuntime;
const softDeleteOp = softDeleteComment as unknown as OperationRuntime;

describe('Comment model authz (#32)', () => {
  it("does NOT grant 'create' on the model — createComment is the sole write path", () => {
    const auth = commentModel.data.authorization;
    const authedRule = auth
      .map((a) => symbolData<AuthData>(a as object))
      .find((r) => r.strategy === 'private');
    expect(authedRule?.operations).not.toContain('create');
    expect(authedRule?.operations).toContain('read');
  });
});

describe('createComment mutation (#32)', () => {
  it('is a GraphQL mutation', () => {
    expect(createOp.data.typeName).toBe('Mutation');
  });

  it('takes messageId + body required; parentCommentId optional', () => {
    const args = createOp.data.arguments;
    expect(args.messageId?.data?.fieldType).toBe('ID');
    expect(args.messageId?.data?.required).toBe(true);
    expect(args.body?.data?.fieldType).toBe('String');
    expect(args.body?.data?.required).toBe(true);
    expect(args.parentCommentId?.data?.fieldType).toBe('ID');
    expect(args.parentCommentId?.data?.required).toBeFalsy();
  });

  it('returns the created Comment row', () => {
    const ret = createOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('Comment');
  });

  it('is authenticated-only', () => {
    const auth = createOp.data.authorization;
    const strategies = auth.map((a) => symbolData<AuthData>(a as object).strategy);
    expect(strategies).toContain('private');
  });

  it('wires the commentMutations Lambda as the handler', () => {
    const handlers = createOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});

describe('softDeleteComment mutation (#32)', () => {
  it('is a GraphQL mutation', () => {
    expect(softDeleteOp.data.typeName).toBe('Mutation');
  });

  it('takes a required commentId + optional reason', () => {
    const args = softDeleteOp.data.arguments;
    expect(args.commentId?.data?.fieldType).toBe('ID');
    expect(args.commentId?.data?.required).toBe(true);
    expect(args.reason?.data?.fieldType).toBe('String');
    expect(args.reason?.data?.required).toBeFalsy();
  });

  it('returns the soft-deleted Comment row', () => {
    const ret = softDeleteOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('Comment');
  });

  it('is authenticated-only (handler enforces author / mod / admin)', () => {
    const auth = softDeleteOp.data.authorization;
    const strategies = auth.map((a) => symbolData<AuthData>(a as object).strategy);
    expect(strategies).toContain('private');
  });

  it('wires the commentMutations Lambda as the handler', () => {
    const handlers = softDeleteOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});
