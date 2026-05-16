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
 * Once #260 lands, the next blocker on full `schema.transform()` is the
 * FieldVote composite-identifier bug tracked at #266 — a separate
 * pre-existing failure unmasked by this fix. The transform-error test
 * scope here is therefore precise: it asserts the #260 error class is
 * gone, not that the whole transform succeeds (yet).
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
    // phase. A separate pre-existing identifier bug (#266) still fails the
    // full transform; the narrow contract here is that the #260 error
    // string is gone.
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
