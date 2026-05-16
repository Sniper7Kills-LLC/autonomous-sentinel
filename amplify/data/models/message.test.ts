import { describe, it, expect } from 'vitest';
import { Message, softDeleteMessage } from './message';

/**
 * Schema-shape tests for the `softDeleteMessage` custom mutation (#28).
 * Pins authz scope (admin-only), arguments (messageId required, reason
 * optional), return type (Message ref), and handler wiring (Lambda).
 *
 * Resolver behaviour lives in `../../functions/messageMutations/handler.test.ts`.
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
  type?: string;
  data?: { fieldType?: string; required?: boolean };
}

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime>;
  };
}

type HandlerRuntime = Record<symbol, unknown>;
type AuthRuntime = Record<symbol, unknown>;

interface AuthData {
  strategy: string;
  groups?: readonly string[];
}

interface CustomHandlerData {
  handler?: unknown;
  entry?: string;
}

function symbolData<T>(obj: object): T {
  const target = obj as Record<symbol, unknown>;
  const sym = Object.getOwnPropertySymbols(target).find(
    (s) => s.description?.toLowerCase() === 'data',
  );
  if (!sym) throw new Error('no Symbol(data) on object');
  return target[sym] as T;
}

const messageModel = Message as unknown as ModelRuntime;
const softDeleteOp = softDeleteMessage as unknown as OperationRuntime;

describe('Message model — soft-delete columns present (#28)', () => {
  it('keeps deletedAt / deletedBy / deletedReason on the row shape', () => {
    const fields = Object.keys(messageModel.data.fields);
    expect(fields).toEqual(expect.arrayContaining(['deletedAt', 'deletedBy', 'deletedReason']));
  });
});

describe('softDeleteMessage mutation (#28)', () => {
  it('is a GraphQL mutation', () => {
    expect(softDeleteOp.data.typeName).toBe('Mutation');
  });

  it('takes a required messageId + optional reason', () => {
    const args = softDeleteOp.data.arguments;
    expect(args.messageId?.data?.fieldType).toBe('ID');
    expect(args.messageId?.data?.required).toBe(true);
    expect(args.reason).toBeDefined();
    expect(args.reason?.data?.fieldType).toBe('String');
    expect(args.reason?.data?.required).toBeFalsy();
  });

  it('returns the soft-deleted Message row (a.ref("Message"))', () => {
    const ret = softDeleteOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('Message');
  });

  it('is admin-only', () => {
    const auth = softDeleteOp.data.authorization;
    expect(auth.length).toBeGreaterThanOrEqual(1);
    const groupsRule = auth
      .map((a) => symbolData<AuthData>(a as object))
      .find((r) => r.strategy === 'groups');
    expect(groupsRule).toBeDefined();
    expect(groupsRule?.groups).toEqual(['admin']);
  });

  it('wires the messageMutations Lambda as the handler', () => {
    const handlers = softDeleteOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});
