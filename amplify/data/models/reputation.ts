import { a } from '@aws-amplify/backend';

/**
 * Reputation — per-User cache that drives vote weight (#36).
 *
 * 1:1 with User via `userId` identifier. Recomputed on Recording publish
 * (validated submission) and TranscriptRevision accept (accepted correction).
 * The exact formula constants live in LinguisticConfig (or a dedicated
 * RepFormulaConfig table) so admins can tune them without a redeploy.
 *
 * Default formula per CLAUDE.md:
 *   `base=1 + 0.1*min(validatedSubmissions, 40) + 0.5*min(acceptedCorrections, 10) + roleBonus`
 * Capped at 5. Role bonuses: moderator=1, admin=2.
 *
 * Deferred:
 *   - Recompute hook Lambda (phase 3 / phase 9).
 *   - Admin formula-tuning UI (phase 4).
 */
export const Reputation = a
  .model({
    // Cognito sub of the owning user — `User.id = cognitoSub` (#259).
    userId: a.id().required(),
    user: a.belongsTo('User', 'userId'),
    validatedSubmissions: a.integer().default(0),
    acceptedCorrections: a.integer().default(0),
    roleBonus: a.float().default(0),
    computedWeight: a.float().required().default(1),
  })
  .identifier(['userId'])
  .authorization((allow) => [
    // Weight is public (drives vote-tally display).
    allow.guest().to(['read']),
    allow.authenticated().to(['read']),
    allow.groups(['admin']).to(['read', 'update']),
  ]);
