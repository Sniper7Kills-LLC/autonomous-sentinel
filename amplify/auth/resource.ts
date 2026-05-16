import { defineAuth, secret } from '@aws-amplify/backend';
import { Lazy } from 'aws-cdk-lib';
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
 *   - Discord federation via the in-house OIDC bridge Lambda (issues #14 +
 *     #254). The bridge's function URL is unknown at module-load time, so its
 *     issuerUrl flows in via `discordIssuerUrl`, a `Lazy.string` placeholder
 *     populated from `backend.ts` after the bridge is constructed. CDK
 *     resolves the lazy at synth, CloudFormation resolves the function URL
 *     token at deploy — no hardcoded URL, single deploy.
 *   - Standard user attributes: email (required) + preferredUsername (optional).
 *   - Groups: admin, moderator, member.
 *   - Post-confirmation trigger assigns new users to `member` (issue #15).
 *
 * Cost: Cognito Advanced Security Features are intentionally NOT enabled at v1
 * (~$0.05/MAU). Revisit if ban-evasion becomes a real problem (see CLAUDE.md).
 *
 * `authConfig` is exported alongside `auth` so unit tests can assert the
 * configuration shape without instantiating CDK constructs.
 */
const callbackUrls = ['http://localhost:3000/', 'https://beta.eam.watch/'];
const logoutUrls = ['http://localhost:3000/', 'https://beta.eam.watch/'];

/**
 * Mutable holder for the Discord OIDC bridge issuer URL. `backend.ts` sets
 * `discordIssuerUrl.url = bridgeFunctionUrl.url` after constructing the bridge
 * function URL; the `Lazy.string` below reads it at CDK synth time.
 *
 * Exported so tests can verify the wiring + so `backend.ts` can assign it.
 */
export const discordIssuerUrl: { url?: string } = {};

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
      oidc: [
        {
          name: 'Discord',
          clientId: secret('DISCORD_CLIENT_ID'),
          clientSecret: secret('DISCORD_CLIENT_SECRET'),
          issuerUrl: Lazy.string({
            produce: () => {
              // Fail loud at synth if `backend.ts` did not populate the holder
              // before the IdP construct was resolved. Silently emitting ''
              // would land us with a Cognito provider whose stored
              // `oidc_issuer` is the empty string, which fails non-obviously
              // at sign-in rather than at deploy.
              const url = discordIssuerUrl.url;
              if (!url) {
                throw new Error(
                  'discordIssuerUrl.url was unset when the Discord OIDC IdP ' +
                    'was resolved. backend.ts must assign it before synth.',
                );
              }
              return url;
            },
          }),
          attributeRequestMethod: 'GET' as const,
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: {
            email: 'email',
            preferredUsername: 'preferred_username',
            fullname: 'name',
          },
        },
      ],
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
