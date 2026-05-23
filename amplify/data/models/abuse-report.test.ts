import { describe, it, expect } from 'vitest';
import { AbuseReport } from './abuse-report';

/**
 * Schema-shape tests for the AbuseReport model (#37).
 *
 * Pins the polymorphic-target row shape + authz contract documented
 * in the issue body:
 *   - Reporters create-only (no edit / delete after submission).
 *   - Reporters read their OWN reports via `ownerDefinedIn('reporterId')`
 *     so they can see status updates.
 *   - Moderators + admins read the whole queue + update status / modAction.
 *   - GSIs power the mod-queue (by status), polymorphic target lookup
 *     (`targetType` + `targetId` sort key), and legacy-claim FK fan-out
 *     (`reporterId`).
 *
 * Behavioural tests for the mod-resolve flow live with the future mod
 * resolver; this file just locks the schema decisions so they don't
 * silently regress.
 */

interface ModelRuntime {
  data: {
    fields: Record<string, FieldRuntime | undefined>;
    authorization: readonly AuthRuntime[];
    secondaryIndexes: readonly IndexRuntime[];
  };
}

interface FieldRuntime {
  data?: { fieldType?: string; required?: boolean };
  type?: string;
  values?: readonly string[];
}

interface IndexRuntime {
  data: {
    partitionKey: string;
    sortKeys?: readonly string[];
  };
}

type AuthRuntime = Record<symbol, unknown>;

interface AuthData {
  strategy: string;
  groups?: readonly string[];
  operations?: readonly string[];
  groupOrOwnerField?: string;
  identityClaim?: string;
}

function authzRules(model: unknown): AuthData[] {
  const surface = model as { data: { authorization: readonly object[] } };
  return surface.data.authorization.map((rule): AuthData => {
    const sym = Object.getOwnPropertySymbols(rule)[0];
    if (!sym) throw new Error('rule has no Symbol payload');
    const payload = (rule as Record<symbol, AuthData | undefined>)[sym];
    if (!payload) throw new Error('rule Symbol payload undefined');
    return payload;
  });
}

const model = AbuseReport as unknown as ModelRuntime;

describe('AbuseReport model — row shape (#37)', () => {
  it('declares the documented columns', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'reporterId',
        'reporter',
        'targetType',
        'targetId',
        'reason',
        'notes',
        'status',
        'resolvedById',
        'resolvedAt',
        'modAction',
      ]),
    );
  });

  it('marks reporterId + targetId as required IDs (FK to User + polymorphic target)', () => {
    expect(model.data.fields.reporterId?.data?.fieldType).toBe('ID');
    expect(model.data.fields.reporterId?.data?.required).toBe(true);
    expect(model.data.fields.targetId?.data?.fieldType).toBe('ID');
    expect(model.data.fields.targetId?.data?.required).toBe(true);
  });

  it('uses an enum for the 4 polymorphic targetTypes per CLAUDE.md (Message, Recording, Comment, User)', () => {
    const f = model.data.fields.targetType;
    expect(f?.type).toBe('enum');
    expect(f?.values).toEqual(['MESSAGE', 'RECORDING', 'COMMENT', 'USER']);
  });

  it('uses an enum for `reason` (spam, offensive, wrong-info, impersonation, other)', () => {
    const f = model.data.fields.reason;
    expect(f?.type).toBe('enum');
    expect(f?.values).toEqual(['SPAM', 'OFFENSIVE', 'WRONG_INFO', 'IMPERSONATION', 'OTHER']);
  });

  it('uses an enum for `status` covering the mod-queue lifecycle', () => {
    const f = model.data.fields.status;
    expect(f?.type).toBe('enum');
    expect(f?.values).toEqual(['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED']);
  });
});

describe('AbuseReport model — secondary indexes (#37)', () => {
  it('indexes by `status` so the mod queue read stays cheap', () => {
    const idx = model.data.secondaryIndexes.find((i) => i.data.partitionKey === 'status');
    expect(idx).toBeDefined();
  });

  it('indexes by (`targetType`, `targetId`) so "all reports against entity X" stays cheap', () => {
    const idx = model.data.secondaryIndexes.find((i) => i.data.partitionKey === 'targetType');
    expect(idx).toBeDefined();
    expect(idx?.data.sortKeys).toEqual(['targetId']);
  });

  it('indexes by `reporterId` for the legacy-claim FK fan-out (#273)', () => {
    const idx = model.data.secondaryIndexes.find((i) => i.data.partitionKey === 'reporterId');
    expect(idx).toBeDefined();
  });
});

describe('AbuseReport model — authorization (#37)', () => {
  const rules = authzRules(AbuseReport);

  it('grants authenticated users `create` only (no edit / delete after submission)', () => {
    const auth = rules.find(
      (r) => (r.strategy === 'public' || r.strategy === 'private') && r.operations,
    );
    expect(auth?.operations).toContain('create');
    expect(auth?.operations).not.toContain('update');
    expect(auth?.operations).not.toContain('delete');
  });

  it('lets the reporter read their own reports via reporterId owner FK', () => {
    const owner = rules.find((r) => r.strategy === 'owner');
    expect(owner).toBeDefined();
    expect(owner?.groupOrOwnerField).toBe('reporterId');
    expect(owner?.identityClaim).toBe('sub');
    expect(owner?.operations).toEqual(['read']);
  });

  it('grants moderators + admins read + update on the queue', () => {
    const mod = rules.find(
      (r) =>
        r.strategy === 'groups' &&
        (r.groups ?? []).includes('moderator') &&
        (r.groups ?? []).includes('admin'),
    );
    expect(mod).toBeDefined();
    expect(mod?.operations).toEqual(expect.arrayContaining(['read', 'update']));
  });
});
