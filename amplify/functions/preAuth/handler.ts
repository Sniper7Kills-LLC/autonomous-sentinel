import type { PreAuthenticationTriggerHandler } from 'aws-lambda';

/**
 * Cognito Pre-Authentication trigger (#335 → patched in follow-up to #420).
 *
 * **Currently a no-op.** The original implementation read the User
 * DynamoDB table to block banned accounts from native sign-in. That
 * direct DDB read from a Lambda in the `auth` nested stack created a
 * CloudFormation cross-stack ref `auth → data` that, combined with the
 * existing `data → auth` (AppSync auth mode + Identity Pool) and
 * `storage → auth` (S3 grants on Identity Pool roles) edges, closed a
 * cycle CDK could not topologically sort. The cycle blocked every
 * Amplify Hosting deploy from job 42 onward — see #420 (and the
 * preTokenGeneration symptom on the same root cause).
 *
 * To restore deploys, the lookup is removed. Banned-user enforcement
 * continues at the AppSync resolver / mutation handler layer: every
 * mutation that mutates state reads `User.bannedAt` before acting, so
 * a banned account that gets a JWT still can't take action. The proper
 * re-introduction (Cognito custom attribute `custom:bannedAt` driven by
 * a DynamoDB stream on the User table) tracks separately.
 *
 * Federated providers (Google + Discord OIDC bridge) always bypassed
 * PreAuth, so the federated-side ban path was already deferred to a
 * follow-up — this change just brings native sign-in into the same
 * "JWT issuance is open, server-side action is gated" posture.
 */

export const BAN_REJECTION_MESSAGE =
  'Account suspended. Contact support if you believe this is in error.';

export const handler: PreAuthenticationTriggerHandler = (event, _context, _callback) => {
  return Promise.resolve(event);
};
