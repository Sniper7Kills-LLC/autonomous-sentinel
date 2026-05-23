import { describe, it, expect } from 'vitest';
import { Donation } from './donation';

/**
 * Schema-shape tests for the Donation model (#40).
 *
 * Pins the Stripe-backed row shape + authz contract from the issue:
 *   - One-time + 3 recurring tiers via `type` enum.
 *   - Stripe IDs (paymentIntent / subscription / checkoutSession) for
 *     idempotent webhook replay.
 *   - `state` enum covers the full Stripe lifecycle.
 *   - `badgeExpiresAt` is server-computed per the CLAUDE.md formula
 *     in the webhook Lambda — the model just stores it.
 *   - GSIs power "donations by user, sorted by occurrence" (profile
 *     page + admin review) and "subscription lookup" (renewal cron).
 *   - Authz: donor + admin read; NO client writes (Stripe webhook
 *     Lambda is the sole writer, wired in phase 9 #160).
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
  data: { partitionKey: string; sortKeys?: readonly string[] };
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

const model = Donation as unknown as ModelRuntime;

describe('Donation model — row shape (#40)', () => {
  it('declares the documented columns', () => {
    const fields = Object.keys(model.data.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        'userId',
        'user',
        'type',
        'amountCents',
        'coverFee',
        'stripePaymentIntentId',
        'stripeSubscriptionId',
        'stripeCheckoutSessionId',
        'badgeExpiresAt',
        'state',
        'occurredAt',
      ]),
    );
  });

  it('marks userId + amountCents as required', () => {
    expect(model.data.fields.userId?.data?.fieldType).toBe('ID');
    expect(model.data.fields.userId?.data?.required).toBe(true);
    expect(model.data.fields.amountCents?.data?.fieldType).toBe('Int');
    expect(model.data.fields.amountCents?.data?.required).toBe(true);
  });

  it('encodes the four supported Stripe transaction shapes via `type` enum', () => {
    const f = model.data.fields.type;
    expect(f?.type).toBe('enum');
    expect(f?.values).toEqual([
      'ONE_TIME',
      'RECURRING_TIER_1',
      'RECURRING_TIER_2',
      'RECURRING_TIER_3',
    ]);
  });

  it('encodes the Stripe transaction lifecycle via `state` enum', () => {
    const f = model.data.fields.state;
    expect(f?.type).toBe('enum');
    expect(f?.values).toEqual(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CANCELLED']);
  });
});

describe('Donation model — secondary indexes (#40)', () => {
  it("indexes (userId, occurredAt) so the profile page can list the donor's history cheaply", () => {
    const idx = model.data.secondaryIndexes.find((i) => i.data.partitionKey === 'userId');
    expect(idx).toBeDefined();
    expect(idx?.data.sortKeys).toEqual(['occurredAt']);
  });

  it('indexes by stripeSubscriptionId so the renewal cron can look up rows by Stripe id', () => {
    const idx = model.data.secondaryIndexes.find(
      (i) => i.data.partitionKey === 'stripeSubscriptionId',
    );
    expect(idx).toBeDefined();
  });
});

describe('Donation model — authorization (#40)', () => {
  const rules = authzRules(Donation);
  const WRITE_OPS = ['create', 'update', 'delete'] as const;
  const hasAnyWrite = (r: AuthData): boolean =>
    WRITE_OPS.some((op) => (r.operations ?? []).includes(op));

  it('grants the donor read on their own rows via userId owner FK', () => {
    const owner = rules.find((r) => r.strategy === 'owner');
    expect(owner).toBeDefined();
    expect(owner?.groupOrOwnerField).toBe('userId');
    expect(owner?.identityClaim).toBe('sub');
    expect(owner?.operations).toEqual(['read']);
  });

  it('grants admins read', () => {
    const adminRule = rules.find(
      (r) => r.strategy === 'groups' && (r.groups ?? []).includes('admin'),
    );
    expect(adminRule).toBeDefined();
    expect(adminRule?.operations).toContain('read');
  });

  it('does NOT expose any client-side write surface — Stripe webhook is the only writer (#160)', () => {
    const writers = rules.filter(hasAnyWrite);
    expect(writers).toEqual([]);
  });
});
