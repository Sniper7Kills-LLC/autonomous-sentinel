import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerHandler } from 'aws-lambda';

const DEFAULT_GROUP = 'member';

const client = new CognitoIdentityProviderClient({});

/**
 * Structural shape of the Amplify Data client surface this handler uses.
 * We pin it narrowly so the unit tests inject a stub without dragging the
 * full `generateClient<Schema>()` type into the test file.
 *
 * `listUserByEmail` is the GSI lookup auto-generated for the `i('email')`
 * secondary index on the User model (#257). A hit means a pre-seeded
 * legacy row exists for this address; the post-confirmation handler
 * skips fresh-row creation so the legacy-claim flow (#16) can rewrite the
 * placeholder cognitoSub.
 */
export interface PostConfirmDataClient {
  models: {
    User: {
      listUserByEmail: (input: {
        email: string;
      }) => Promise<{ data: unknown[] | null; errors?: unknown }>;
      create: (input: {
        cognitoSub: string;
        email?: string | null;
        preferredUsername?: string | null;
        displayName?: string | null;
        claimStatus?: string;
        piiBlanked?: boolean;
      }) => Promise<{ data: unknown; errors?: unknown }>;
      update: (input: {
        cognitoSub: string;
        [k: string]: unknown;
      }) => Promise<{ data: unknown; errors?: unknown }>;
    };
  };
}

interface DataDeps {
  client?: PostConfirmDataClient;
}

let injected: DataDeps = {};

/** Test-only escape hatch: replace the Amplify Data client. */
export function __setDataDeps(deps: DataDeps): void {
  injected = deps;
}

export function __resetDataDeps(): void {
  injected = {};
}

let cachedClient: PostConfirmDataClient | undefined;

async function getDataClient(): Promise<PostConfirmDataClient> {
  if (injected.client) return injected.client;
  if (cachedClient) return cachedClient;
  // Dynamic import so unit tests that inject a stub never bootstrap the
  // Amplify runtime.
  const mod = await import('aws-amplify/data');
  cachedClient = mod.generateClient({ authMode: 'iam' }) as unknown as PostConfirmDataClient;
  return cachedClient;
}

/**
 * Write the User shadow row for a freshly-signed-up Cognito identity
 * (issue #248). Idempotent enough for Cognito's at-least-once retries:
 *   - On a fresh signup we call `User.create` with the Cognito sub as
 *     the partition key.
 *   - On a legacy-email match we skip creation; the claim flow (#16)
 *     handles the placeholder → real-sub rewrite.
 *
 * Failures here are logged but never rethrown — the group-add side has
 * already happened by the time we get here and we don't want a DDB
 * blip to break sign-up. The row can always be reconciled later by an
 * admin tool / scheduled job.
 */
async function ensureUserRow(input: {
  cognitoSub: string;
  email: string | undefined;
}): Promise<void> {
  let data: PostConfirmDataClient;
  try {
    data = await getDataClient();
  } catch (err) {
    console.error('postConfirmation: failed to obtain data client', err);
    return;
  }

  // Legacy email match — skip fresh-row creation. Row rewrite is owned
  // by the claim flow in #16.
  if (input.email) {
    try {
      const lookup = await data.models.User.listUserByEmail({ email: input.email });
      if (lookup.data && lookup.data.length > 0) {
        console.info('postConfirmation: legacy row exists for email, skipping create', {
          cognitoSub: input.cognitoSub,
        });
        return;
      }
    } catch (err) {
      // Lookup failure is not fatal — fall through to attempt create.
      console.error('postConfirmation: legacyEmail lookup failed', err);
    }
  }

  try {
    const result = await data.models.User.create({
      cognitoSub: input.cognitoSub,
      email: input.email ?? null,
      claimStatus: 'FRESH_SIGNUP',
      piiBlanked: false,
    });
    if (result.errors) {
      console.error('postConfirmation: User.create returned errors', result.errors);
      return;
    }
    console.info('postConfirmation: User row created', { cognitoSub: input.cognitoSub });
  } catch (err) {
    console.error('postConfirmation: User.create threw', err);
  }
}

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const { userPoolId, userName, triggerSource } = event;

  // Only react to genuine confirmations. PostConfirmation_ConfirmForgotPassword
  // fires on password recovery — the user already exists and is already in the
  // group, so re-adding is a no-op but skipping it avoids needless API calls.
  if (
    triggerSource !== 'PostConfirmation_ConfirmSignUp' &&
    triggerSource !== 'PostConfirmation_ConfirmForgotPassword'
  ) {
    return event;
  }

  await client.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: userName,
      GroupName: DEFAULT_GROUP,
    }),
  );

  console.info('postConfirmation: added to group', {
    userPoolId,
    userName,
    group: DEFAULT_GROUP,
  });

  // On a fresh sign-up only (not password reset), make sure the User
  // shadow row exists. Sub + email come from the verified Cognito user
  // attributes (#15 ensures email-verified is required at signup).
  if (triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const sub = event.request.userAttributes?.sub;
    const email = event.request.userAttributes?.email;
    if (sub) {
      await ensureUserRow({ cognitoSub: sub, email });
    } else {
      console.error('postConfirmation: missing sub in userAttributes', {
        userPoolId,
        userName,
      });
    }
  }

  return event;
};
