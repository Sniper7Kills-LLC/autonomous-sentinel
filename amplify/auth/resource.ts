import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito User Pool. Email + Google + Discord (Discord via OIDC bridge — wired separately).
 *
 * Email verification is required at signup (per CLAUDE.md).
 * Cognito Advanced Security Features are intentionally OFF at v1 (cost — see CLAUDE.md).
 *
 * TODO once OIDC bridge for Discord is set up:
 *   - register the bridge as an OIDC identity provider here
 *   - add 'oidc' to externalProviders below
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
    externalProviders: {
      google: {
        clientId: secret('GOOGLE_CLIENT_ID'),
        clientSecret: secret('GOOGLE_CLIENT_SECRET'),
        scopes: ['email', 'profile'],
      },
      callbackUrls: ['http://localhost:3000/', 'https://beta.eam.watch/'],
      logoutUrls: ['http://localhost:3000/', 'https://beta.eam.watch/'],
    },
  },
  userAttributes: {
    email: { required: true, mutable: true },
    preferredUsername: { required: false, mutable: true },
  },
  groups: ['admin', 'moderator', 'member'],
});

function secret(name: string) {
  // Placeholder — replace with `import { secret } from '@aws-amplify/backend'` once
  // Amplify secrets are configured via `npx ampx sandbox secret set <NAME>`.
  return { name } as unknown as string;
}
