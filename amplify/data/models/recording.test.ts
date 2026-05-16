import { describe, it, expect } from 'vitest';
import { Recording, softDeleteRecording } from './recording';

/**
 * Schema-shape tests for the `softDeleteRecording` custom mutation (#29).
 * Pins authz scope (admin-only), arguments (recordingId required, reason
 * optional), return type (Recording ref), and handler wiring (Lambda).
 *
 * Resolver behaviour lives in `../../functions/recordingMutations/handler.test.ts`.
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
  data: { fields: Record<string, FieldRuntime> };
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

const recordingModel = Recording as unknown as ModelRuntime;
const softDeleteOp = softDeleteRecording as unknown as OperationRuntime;

describe('Recording model — soft-delete columns present (#29)', () => {
  it('keeps deletedAt + deletedBy on the row shape (no deletedReason — audit-only)', () => {
    const fields = Object.keys(recordingModel.data.fields);
    expect(fields).toEqual(expect.arrayContaining(['deletedAt', 'deletedBy']));
    expect(fields).not.toContain('deletedReason');
  });
});

describe('softDeleteRecording mutation (#29)', () => {
  it('is a GraphQL mutation', () => {
    expect(softDeleteOp.data.typeName).toBe('Mutation');
  });

  it('takes a required recordingId + optional reason', () => {
    const args = softDeleteOp.data.arguments;
    expect(args.recordingId?.data?.fieldType).toBe('ID');
    expect(args.recordingId?.data?.required).toBe(true);
    expect(args.reason?.data?.fieldType).toBe('String');
    expect(args.reason?.data?.required).toBeFalsy();
  });

  it('returns the soft-deleted Recording row (a.ref("Recording"))', () => {
    const ret = softDeleteOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('Recording');
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

  it('wires the recordingMutations Lambda as the handler', () => {
    const handlers = softDeleteOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});
