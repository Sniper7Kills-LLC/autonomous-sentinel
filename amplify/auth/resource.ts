import { defineAuth, secret } from '@aws-amplify/backend';
import { Lazy } from 'aws-cdk-lib';
import { postConfirmation } from '../functions/postConfirmation/resource';
import { preTokenGeneration } from '../functions/preTokenGeneration/resource';

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
 * function URL; the `Lazy.uncachedString` below re-reads it on every token
 * resolution so the final CFN synth picks up the real URL.
 *
 * Exported so tests can verify the wiring + so `backend.ts` can assign it.
 */
export const discordIssuerUrl: { url?: string } = {};

/**
 * Placeholder issuer URL surfaced when the holder is empty during
 * `defineBackend()`'s internal token-resolution pass (which runs
 * before `backend.ts` has wired the bridge function URL). The
 * resolver is uncached, so this placeholder is replaced by the real
 * URL on the final synth pass once `backend.ts` populates the holder.
 *
 * Exported so tests can pin the contract (a non-empty string returned
 * when the holder is unset, never a throw).
 */
export const DISCORD_ISSUER_URL_PLACEHOLDER = 'https://discord-bridge-unwired.invalid/';

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
          issuerUrl: Lazy.uncachedString({
            produce: () => {
              // `defineBackend()` runs an internal token-resolution pass
              // before returning the backend object — earlier than the
              // mutation in `backend.ts` that populates the holder. The
              // old `Lazy.string({produce})` threw here in that early
              // pass and blocked every `ampx sandbox` deploy (#310).
              //
              // Soft-default to a syntactically valid placeholder when
              // the holder is unset so the early resolution pass
              // survives. `Lazy.uncachedString` re-invokes `produce`
              // on every token resolution, so once `backend.ts` writes
              // the real URL into the holder, the final synth pass
              // emits the real value into the CFN template.
              //
              // The placeholder uses the reserved `.invalid` TLD so a
              // misconfiguration that ever leaks it past synth (e.g. a
              // future CDK pass that snapshots produce results before
              // backend.ts runs) fails closed at sign-in instead of
              // silently pointing Cognito at a real host.
              const url = discordIssuerUrl.url;
              return url ?? DISCORD_ISSUER_URL_PLACEHOLDER;
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
    preTokenGeneration,
  },
  access: (allow: AuthAccessAllow) => [allow.resource(postConfirmation).to(['addUserToGroup'])],
};

type AuthAccessAllow = Parameters<NonNullable<Parameters<typeof defineAuth>[0]['access']>>[0];

export const auth = defineAuth(authConfig);
