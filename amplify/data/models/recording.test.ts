import { describe, it, expect } from 'vitest';
import { Recording, softDeleteRecording, submitRecording } from './recording';

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

const recordingModel = Recording as unknown as ModelRuntime;
const softDeleteOp = softDeleteRecording as unknown as OperationRuntime;
const submitOp = submitRecording as unknown as OperationRuntime;

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

describe('Recording model — authenticated create dropped (#284)', () => {
  it('does not grant `create` to authenticated callers (submitRecording is the sole create path)', () => {
    const rules = recordingModel.data.authorization.map((r) =>
      symbolData<AuthData & { operations?: string[] }>(r as object),
    );
    const authRule = rules.find((r) => r.strategy === 'private');
    expect(authRule).toBeDefined();
    expect(authRule?.operations ?? []).not.toContain('create');
  });

  it('still lets guests read', () => {
    const rules = recordingModel.data.authorization.map((r) =>
      symbolData<AuthData & { operations?: string[] }>(r as object),
    );
    const guestRule = rules.find((r) => r.strategy === 'public');
    expect(guestRule).toBeDefined();
    expect(guestRule?.operations ?? []).toContain('read');
  });

  it('does not grant `create` to the moderator+admin group either (mods go through submitRecording too)', () => {
    // Reviewer flagged on the #284 self-review pass: leaving
    // `create` on the mod/admin group would expose the auto-
    // generated `createRecording` mutation as a back-door that
    // bypasses contentHash uniqueness. Mods + admins go through
    // submitRecording like everyone else; they keep update/delete
    // for moderation actions.
    const rules = recordingModel.data.authorization.map((r) =>
      symbolData<AuthData & { operations?: string[] }>(r as object),
    );
    const groupsRule = rules.find((r) => r.strategy === 'groups');
    expect(groupsRule?.groups ?? []).toEqual(expect.arrayContaining(['moderator', 'admin']));
    expect(groupsRule?.operations ?? []).not.toContain('create');
    expect(groupsRule?.operations ?? []).toEqual(
      expect.arrayContaining(['read', 'update', 'delete']),
    );
  });
});

describe('submitRecording mutation (#284)', () => {
  it('is a GraphQL mutation', () => {
    expect(submitOp.data.typeName).toBe('Mutation');
  });

  it('requires contentHash + originalKey, optional pass-throughs', () => {
    const args = submitOp.data.arguments;
    expect(args.contentHash?.data?.fieldType).toBe('String');
    expect(args.contentHash?.data?.required).toBe(true);
    expect(args.originalKey?.data?.fieldType).toBe('String');
    expect(args.originalKey?.data?.required).toBe(true);
    // Optional pass-throughs — present but not required.
    expect(args.messageId?.data?.required).toBeFalsy();
    expect(args.frequencyKhz?.data?.required).toBeFalsy();
    expect(args.modulation?.data?.required).toBeFalsy();
    expect(args.broadcastedAt?.data?.required).toBeFalsy();
    expect(args.automated?.data?.required).toBeFalsy();
    expect(args.sdrId?.data?.required).toBeFalsy();
    expect(args.webCanonicalKey?.data?.required).toBeFalsy();
    expect(args.durationMs?.data?.required).toBeFalsy();
  });

  it('returns the created Recording row (a.ref("Recording"))', () => {
    const ret = submitOp.data.returnType;
    const linkName = ret.data?.link ?? ret.data?.type;
    expect(linkName).toBe('Recording');
  });

  it('is authenticated-only (any signed-in user; no guest, no group gate)', () => {
    const auth = submitOp.data.authorization;
    expect(auth.length).toBeGreaterThanOrEqual(1);
    const rules = auth.map((a) => symbolData<AuthData>(a as object));
    expect(rules.some((r) => r.strategy === 'private')).toBe(true);
    expect(rules.some((r) => r.strategy === 'public')).toBe(false);
    expect(rules.some((r) => r.strategy === 'groups')).toBe(false);
  });

  it('wires the recordingMutations Lambda as the handler', () => {
    const handlers = submitOp.data.handlers;
    expect(handlers).toHaveLength(1);
    const cfg = symbolData<CustomHandlerData>(handlers[0] as object);
    expect(cfg.handler).toBeDefined();
  });
});
