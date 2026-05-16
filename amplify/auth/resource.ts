import { defineAuth } from '@aws-amplify/backend';
import { postConfirmation } from '../functions/postConfirmation/resource';

/**
 * Cognito User Pool for Autonomous Sentinel.
 *
 * Current scope:
 *   - Email login with email verification required at signup (Cognito's default
 *     CODE-style verification when `loginWith.email === true`).
 *   - Standard user attributes: email (required) + preferredUsername (optional).
 *   - Groups: admin, moderator, member.
 *   - Post-confirmation trigger assigns new users to `member` (issue #15).
 *
 * Deliberately out of scope here (separate issues land them):
 *   - Google federation         → issue #13
 *   - Discord OIDC bridge       → issue #14
 *
 * Cost: Cognito Advanced Security Features are intentionally NOT enabled at v1
 * (~$0.05/MAU). Revisit if ban-evasion becomes a real problem (see CLAUDE.md).
 *
 * `authConfig` is exported alongside `auth` so unit tests can assert the
 * configuration shape without instantiating CDK constructs.
 */
export const authConfig = {
  loginWith: {
    email: true as const,
  },
  userAttributes: {
    email: { required: true, mutable: true },
    preferredUsername: { required: false, mutable: true },
  },
  groups: ['admin', 'moderator', 'member'] as string[],
  triggers: {
    postConfirmation,
  },
  access: (allow: AuthAccessAllow) => [
    allow.resource(postConfirmation).to(['addUserToGroup']),
  ],
};

type AuthAccessAllow = Parameters<
  NonNullable<Parameters<typeof defineAuth>[0]['access']>
>[0];

export const auth = defineAuth(authConfig);
