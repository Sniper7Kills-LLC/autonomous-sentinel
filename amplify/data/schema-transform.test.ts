import { describe, it, expect } from 'vitest';

import { schema } from './resource';
import { Recording } from './models/recording';
import { Message } from './models/message';

/**
 * Regression coverage for issue #260.
 *
 * Amplify Gen 2 requires every `belongsTo` to have a matching `hasMany` /
 * `hasOne` on the other side. `Recording.deletedByUser = belongsTo('User',
 * 'deletedBy')` (introduced in PR #257) lacked a reciprocal on `User`, which
 * made the full schema fail `schema.transform()` end-to-end with:
 *
 *   Unable to find associated relationship definition in User for
 *   Recording.deletedByUser: User @belongsTo(references: ['deletedBy'])
 *
 * The decision recorded on #260 was Option 2: drop the `deletedByUser`
 * belongsTo and treat `deletedBy` as a plain Cognito-sub `a.id()` field
 * (matches `AuditLog.actorId` and the Option A sub-as-id philosophy now
 * baked in via #259). Admins resolve the actor User via a separate query
 * when needed; we do not need the relationship in the graph for what is a
 * denormalised admin-only read.
 *
 * Tests here:
 *   - `schema.transform()` no longer throws the "missing reciprocal
 *     relationship" error that #260 was filed against.
 *   - Soft-delete actor FKs (`Recording.deletedBy`, `Message.deletedBy`)
 *     remain as plain `a.id()` fields (nullable, no belongsTo).
 *
 * Once #260 landed, the next blocker on full `schema.transform()` was the
 * FieldVote composite-identifier bug tracked at #266 — a separate
 * pre-existing failure unmasked by the #260 fix. With #266 resolved
 * (synthesised `fieldKey` PK, see `field-vote.ts`), the full transform
 * now succeeds end-to-end, so we additionally assert that — the
 * "schema.transform() succeeds against the full data model" half of
 * #260's acceptance criteria can finally close.
 */

type ScalarFieldShape = {
  data: { fieldType: string; required: boolean };
};

type ModelSurface = {
  data: {
    fields: Record<string, unknown>;
  };
};

function getField(model: unknown, name: string): unknown {
  return (model as ModelSurface).data.fields[name];
}

describe('schema.transform() — Recording.deletedByUser no longer breaks it (issue #260)', () => {
  it('does not throw the missing-reciprocal-relationship error', () => {
    // We expect the transform to advance past the relationship-validation
    // phase. With #266 (FieldVote synthesised composite PK) merged, the
    // full transform now succeeds — see the "full transform succeeds"
    // test below for that stronger guarantee.
    let caught: unknown;
    try {
      schema.transform();
    } catch (e) {
      caught = e;
    }
    if (caught instanceof Error) {
      expect(caught.message).not.toMatch(
        /Unable to find associated relationship definition in User for Recording\.deletedByUser/,
      );
      expect(caught.message).not.toMatch(/Recording\.deletedByUser/);
    }
  });
});

describe('schema.transform() — full data model transforms cleanly (issues #260, #266)', () => {
  it('does not throw the FieldVote identifier error from #266', () => {
    // PR #257 set `.identifier(['messageId', 'field', 'voterId'])` on
    // FieldVote with `field: a.enum([...])`. The enum type exposes no
    // `.required()` modifier so the identifier was structurally invalid:
    //
    //   Invalid identifier definition. Field field cannot be used in the
    //   identifier. Identifiers must reference required or DB-generated
    //   fields
    //
    // #266 swaps the composite identifier for a synthesised
    // `fieldKey: a.string().required()` column written by the
    // `castFieldVote` mutation resolver. The transform must no longer
    // surface that error class for any FieldVote column.
    let caught: unknown;
    try {
      schema.transform();
    } catch (e) {
      caught = e;
    }
    if (caught instanceof Error) {
      expect(caught.message).not.toMatch(/Field field cannot be used in the identifier/);
      expect(caught.message).not.toMatch(/Invalid identifier definition.*FieldVote/);
    }
  });

  it('returns a populated transform without throwing', () => {
    // The whole point of #266 (closing #260's last AC half) — the full
    // schema must transform end-to-end.
    expect(() => schema.transform()).not.toThrow();
    const out = schema.transform();
    // Sanity-check that we got back a real result and not an empty stub.
    expect(out).toBeDefined();
    expect(out).not.toBeNull();
  });
});

describe('Soft-delete actor FKs are sub-as-id, not relationships (issue #260)', () => {
  it('Recording.deletedBy is a plain id field (Cognito sub string)', () => {
    const field = getField(Recording, 'deletedBy') as ScalarFieldShape;
    expect(field.data.fieldType).toBe('ID');
    // Nullable — recordings are not deleted by default.
    expect(field.data.required).toBe(false);
  });

  it('Recording has no `deletedByUser` belongsTo relationship', () => {
    expect(getField(Recording, 'deletedByUser')).toBeUndefined();
  });

  it('Message.deletedBy is a plain id field (Cognito sub string)', () => {
    const field = getField(Message, 'deletedBy') as ScalarFieldShape;
    expect(field.data.fieldType).toBe('ID');
    expect(field.data.required).toBe(false);
  });

  it('Message has no `deletedByUser` belongsTo relationship', () => {
    expect(getField(Message, 'deletedByUser')).toBeUndefined();
  });
});
