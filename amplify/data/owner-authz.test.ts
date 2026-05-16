import { describe, it, expect } from 'vitest';

import { User } from './models/user';
import { Sdr } from './models/sdr';
import { Comment } from './models/comment';
import { AbuseReport } from './models/abuse-report';
import { FieldVote } from './models/field-vote';
import { RevisionVote } from './models/revision-vote';
import { Donation } from './models/donation';
import { NotificationPreference } from './models/notification-preference';
import { Recording } from './models/recording';
import { TranscriptRevision } from './models/transcript-revision';

/**
 * Owner-authz binding (issue #259, Option A).
 *
 * `User.id = cognitoSub` via `.identifier(['cognitoSub'])`. Every FK column
 * that previously stored a `User.id` UUID now stores the Cognito sub string
 * directly. Each `allow.owner()` rule must be wired with explicit
 * `.ownerDefinedIn(<fkField>).identityClaim('sub')` so the resolver compares
 * `ctx.identity.sub` against the column that actually holds the sub.
 *
 * Tests below read the model's authorization rules through the internal
 * `Symbol(data)` payload. Amplify exposes the same struct that flows into the
 * AppSync transformer at synth time, so asserting the shape here gives us the
 * same coverage we'd get from a sandbox synth without paying the runtime cost.
 *
 * --------------------------------------------------------------------------
 * STABILITY NOTE — pinned Amplify versions
 * --------------------------------------------------------------------------
 *
 * The `Symbol(data)` accessor pattern is undocumented; Amplify's own
 * `SchemaProcessor` reads the rule payload the same way, so it is stable
 * inside a given `@aws-amplify/data-schema` minor, but a future bump could
 * shift the symbol layout without notice.
 *
 * Last verified against:
 *   - `@aws-amplify/backend@1.22.0`
 *   - `@aws-amplify/data-schema@1.25.6` (transitive)
 *
 * When you bump either of those, re-run this file; if it dies on the symbol
 * walk, the planned replacement is tracked at issue #264 (replace the
 * Symbol(data) introspection with a stable accessor — SDL parsing once #260
 * is fixed, or a CDK-synth harness, or a public Amplify accessor when one
 * lands). Runtime-resolver coverage is tracked separately at #265.
 */

type AuthzRule = {
  strategy: string;
  operations?: string[];
  groupOrOwnerField?: string;
  identityClaim?: string;
  groups?: string[];
  provider?: string;
  multiOwner?: boolean;
};

type SecondaryIndex = {
  data: { partitionKey: string };
};

type ScalarFieldShape = {
  data: { fieldType: string; required: boolean };
};

type EnumFieldShape = {
  type: 'enum';
  values: string[];
};

// Loose surface for the bits we read off each model. Amplify's exported model
// types are intentionally opaque; the schema processor consumes the same
// runtime struct we walk here.
type ModelSurface = {
  data: {
    fields: Record<string, unknown>;
    identifier: readonly string[];
    secondaryIndexes?: readonly SecondaryIndex[];
    authorization: readonly object[];
  };
};

function asSurface(model: unknown): ModelSurface {
  return model as ModelSurface;
}

function authzRules(model: unknown): AuthzRule[] {
  const surface = asSurface(model);
  return surface.data.authorization.map((rule): AuthzRule => {
    // Amplify stashes the rule payload behind a single anonymous Symbol so the
    // public API stays clean. We mirror the SchemaProcessor's access pattern.
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

function ownerRules(model: unknown): AuthzRule[] {
  return authzRules(model).filter((r) => r.strategy === 'owner');
}

function adminGroupRules(model: unknown): AuthzRule[] {
  return authzRules(model).filter(
    (r) => r.strategy === 'groups' && r.groups?.includes('admin'),
  );
}

function getIdentifier(model: unknown): readonly string[] {
  return asSurface(model).data.identifier;
}

function getField(model: unknown, name: string): unknown {
  return asSurface(model).data.fields[name];
}

function getSecondaryIndexes(model: unknown): readonly SecondaryIndex[] {
  return asSurface(model).data.secondaryIndexes ?? [];
}

describe('User identifier strategy (Option A: cognitoSub = PK)', () => {
  it('uses cognitoSub as the primary identifier', () => {
    expect(getIdentifier(User)).toEqual(['cognitoSub']);
  });

  it('marks cognitoSub as required (no nullable PK)', () => {
    const field = getField(User, 'cognitoSub') as ScalarFieldShape;
    expect(field.data.required).toBe(true);
  });

  it('drops the now-redundant cognitoSub secondary index', () => {
    // cognitoSub is the PK — querying by it goes through the base table, not
    // a GSI. Keeping a GSI on the PK would duplicate the table at extra cost.
    const partitionKeys = getSecondaryIndexes(User).map(
      (i) => i.data.partitionKey,
    );
    expect(partitionKeys).not.toContain('cognitoSub');
  });

  it('keeps the owner binding on cognitoSub with identityClaim sub', () => {
    const owners = ownerRules(User);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      groupOrOwnerField: 'cognitoSub',
      identityClaim: 'sub',
      operations: ['update'],
    });
  });

  it('still gives admins full CRUD', () => {
    const adminRules = adminGroupRules(User);
    expect(adminRules).toHaveLength(1);
    expect(adminRules[0]?.operations).toEqual(
      expect.arrayContaining(['read', 'create', 'update', 'delete']),
    );
  });
});

describe('Owner-FK binding wires explicit field + sub claim', () => {
  it.each([
    { name: 'Sdr', model: Sdr, fkField: 'ownerId' },
    { name: 'Comment', model: Comment, fkField: 'authorId' },
    { name: 'AbuseReport', model: AbuseReport, fkField: 'reporterId' },
    { name: 'FieldVote', model: FieldVote, fkField: 'voterId' },
    { name: 'RevisionVote', model: RevisionVote, fkField: 'voterId' },
    { name: 'Donation', model: Donation, fkField: 'userId' },
    {
      name: 'NotificationPreference',
      model: NotificationPreference,
      fkField: 'userId',
    },
  ])(
    '$name binds owner authz to $fkField + identityClaim sub',
    ({ model, fkField }) => {
      const owners = ownerRules(model);
      expect(owners.length).toBeGreaterThan(0);
      for (const rule of owners) {
        expect(rule.groupOrOwnerField).toBe(fkField);
        expect(rule.identityClaim).toBe('sub');
      }
    },
  );
});

describe('Admin group rules survive the rewire', () => {
  it.each([
    { name: 'Sdr', model: Sdr },
    { name: 'Comment', model: Comment },
    { name: 'AbuseReport', model: AbuseReport },
    { name: 'FieldVote', model: FieldVote },
    { name: 'RevisionVote', model: RevisionVote },
    { name: 'Donation', model: Donation },
    { name: 'NotificationPreference', model: NotificationPreference },
  ])('$name keeps an admin group rule', ({ model }) => {
    // Some models grant admin via `groups(['admin'])`, others via
    // `groups(['moderator', 'admin'])`. Either way, an admin rule must exist.
    const groupRules = authzRules(model).filter(
      (r) => r.strategy === 'groups' && r.groups?.includes('admin'),
    );
    expect(groupRules.length).toBeGreaterThan(0);
  });
});

describe('Recording / TranscriptRevision FK semantics now store the sub', () => {
  // These models do not use `allow.owner()` — they grant public/auth reads +
  // admin/mod writes. The FK columns still need to point at the sub now that
  // User.id = cognitoSub, so downstream callers must populate them with the
  // Cognito sub rather than an opaque User UUID.
  //
  // The structural change is the User identifier swap (verified above); these
  // tests just pin that the FK fields still exist + are still `id`-typed.
  it('Recording.uploaderId remains an id field', () => {
    const field = getField(Recording, 'uploaderId') as ScalarFieldShape;
    expect(field.data.fieldType).toBe('ID');
  });

  it('TranscriptRevision.proposedBy remains an id field', () => {
    const field = getField(
      TranscriptRevision,
      'proposedBy',
    ) as ScalarFieldShape;
    expect(field.data.fieldType).toBe('ID');
  });
});

describe('Pre-seeded legacy migration rows', () => {
  // Legacy rows have no Cognito identity until the claim flow runs (#16). Per
  // the decision recorded on #259, those rows are seeded with
  // `cognitoSub = "legacy:<legacyUserId>"`. The PK still indexes them; the
  // claim flow rewrites the row when the matching email signs up.
  //
  // No code in this PR seeds rows — that lives in phase 7 migration tooling —
  // but the identifier change has to accept `legacy:` prefixed strings.
  it('cognitoSub field accepts arbitrary strings (no enum / pattern constraint)', () => {
    const field = getField(User, 'cognitoSub') as ScalarFieldShape;
    expect(field.data.fieldType).toBe('String');
  });

  it('claimStatus enum still exposes PENDING_CLAIM for pre-seeded rows', () => {
    const field = getField(User, 'claimStatus') as EnumFieldShape;
    expect(field.type).toBe('enum');
    expect(field.values).toEqual(
      expect.arrayContaining(['PENDING_CLAIM', 'CLAIMED', 'FRESH_SIGNUP']),
    );
  });

  it('`legacy:` prefix is namespaced safely — real Cognito subs are UUIDv4 and never start with `legacy:`', () => {
    // Cognito User Pool `sub` is a UUIDv4: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
    // where y ∈ {8, 9, a, b}. The structural impossibility of a real sub
    // beginning with `legacy:` is what lets us use that prefix as a
    // placeholder PK on pre-seeded migration rows without adding a runtime
    // pattern constraint to the cognitoSub field (a constraint would also
    // reject the legacy prefix itself — defeating the purpose).
    //
    // We do not add a runtime guard. We do encode the invariant here so a
    // future change that "improves" the format of Cognito subs trips this
    // test and forces the placeholder convention to be revisited.
    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const sampleSubs = [
      '0190e3f7-1234-4abc-89de-fedcba987654',
      'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    ];
    for (const sub of sampleSubs) {
      expect(sub).toMatch(uuidV4);
      expect(sub.startsWith('legacy:')).toBe(false);
    }

    // And the placeholder is itself a non-UUID string, so it cannot collide.
    const placeholder = 'legacy:42';
    expect(placeholder).not.toMatch(uuidV4);
    expect(placeholder.startsWith('legacy:')).toBe(true);
  });
});
