import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito User Pool for Autonomous Sentinel.
 *
 * Scope of this resource (issue #12):
 *   - Email login with email verification required at signup (Cognito's default
 *     CODE-style verification when `loginWith.email === true`).
 *   - Standard user attributes: email (required) + preferredUsername (optional).
 *   - Groups: admin, moderator, member.
 *
 * Deliberately out of scope here (separate issues land them):
 *   - Google federation         → issue #13
 *   - Discord OIDC bridge       → issue #14
 *   - Post-confirmation Lambda  → issue #15 (auto-assigns 'member' group)
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
};

export const auth = defineAuth(authConfig);
