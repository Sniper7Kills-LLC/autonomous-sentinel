import { defineAuth, secret } from '@aws-amplify/backend';
import { postConfirmation } from '../functions/postConfirmation/resource';

/**
 * Cognito User Pool for Autonomous Sentinel.
 *
 * Current scope:
 *   - Email login with email verification required at signup (Cognito's default
 *     CODE-style verification when `loginWith.email === true`).
 *   - Google federation (issue #13) — clientId / clientSecret come from
 *     Amplify-managed secrets, set with `npx ampx sandbox secret set
 *     GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` before deploy.
 *   - Standard user attributes: email (required) + preferredUsername (optional).
 *   - Groups: admin, moderator, member.
 *   - Post-confirmation trigger assigns new users to `member` (issue #15).
 *
 * Deliberately out of scope here (separate issues land them):
 *   - Discord OIDC bridge → issue #14
 *
 * Cost: Cognito Advanced Security Features are intentionally NOT enabled at v1
 * (~$0.05/MAU). Revisit if ban-evasion becomes a real problem (see CLAUDE.md).
 *
 * `authConfig` is exported alongside `auth` so unit tests can assert the
 * configuration shape without instantiating CDK constructs.
 */
const callbackUrls = ['http://localhost:3000/', 'https://beta.eam.watch/'];
const logoutUrls = ['http://localhost:3000/', 'https://beta.eam.watch/'];

export const authConfig = {
  loginWith: {
    email: true as const,
    externalProviders: {
      google: {
        clientId: secret('GOOGLE_CLIENT_ID'),
        clientSecret: secret('GOOGLE_CLIENT_SECRET'),
        scopes: ['email', 'profile'],
        attributeMapping: {
          email: 'email',
        },
      },
      callbackUrls,
      logoutUrls,
    },
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
