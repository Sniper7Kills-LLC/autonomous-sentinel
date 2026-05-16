import { defineBackend } from '@aws-amplify/backend';
import { Fn } from 'aws-cdk-lib';
import {
  type Function as LambdaFunction,
  FunctionUrlAuthType,
  InvokeMode,
} from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { auth, discordIssuerUrl } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { preprocess } from './functions/preprocess/resource';
import { transcribe } from './functions/transcribe/resource';
import { linguistic } from './functions/linguistic/resource';
import { postConfirmation } from './functions/postConfirmation/resource';
import { discordOidcBridge } from './functions/discordOidcBridge/resource';
import { userMutations } from './functions/userMutations/resource';
import { messageMutations } from './functions/messageMutations/resource';
import { getUserPublicLambda } from './functions/getUserPublicLambda/resource';
import { legacyClaimWorker } from './functions/legacyClaimWorker/resource';
import { legacyClaimReplaySweeper } from './functions/legacyClaimReplaySweeper/resource';
import { fieldVoteOrphanJanitor } from './functions/fieldVoteOrphanJanitor/resource';
import { attachBudgetAlarms, readBudgetConfig } from './budgets';

const backend = defineBackend({
  auth,
  data,
  storage,
  preprocess,
  transcribe,
  linguistic,
  postConfirmation,
  discordOidcBridge,
  userMutations,
  messageMutations,
  getUserPublicLambda,
  legacyClaimWorker,
  legacyClaimReplaySweeper,
  fieldVoteOrphanJanitor,
});

// Wire the legacy-claim worker into postConfirmation (sub-A of #16 / #272).
//
// postConfirmation async-invokes the worker on a legacy-email match so
// the user's sign-up does not block on the DDB transact + audit write.
// The worker re-queries the legacy row server-side, runs the helper
// `linkLegacyClaim`, and emits the `USER_CLAIM` audit entry.
//
// Two wiring pieces:
//   1. Function-name env var on postConfirmation so its `InvokeCommand`
//      can target the worker without an SDK lookup.
//   2. IAM grant: postConfirmation → `lambda:InvokeFunction` on worker;
//      worker → `dynamodb:TransactWriteItems` on the User table; worker
//      gets `USER_TABLE_NAME` env so it can address that table.
const userTable = backend.data.resources.tables['User'];
if (!userTable) {
  // Defensive — Amplify always emits the User table for our schema.
  // A missing entry means the data stack failed to synth, which would
  // already break the build downstream. Throw here for a clearer error.
  throw new Error('backend: User table not found on data resources');
}
const legacyClaimWorkerLambda = backend.legacyClaimWorker.resources.lambda as LambdaFunction;
const postConfirmationLambda = backend.postConfirmation.resources.lambda as LambdaFunction;

postConfirmationLambda.addEnvironment(
  'LEGACY_CLAIM_WORKER_FUNCTION_NAME',
  legacyClaimWorkerLambda.functionName,
);
legacyClaimWorkerLambda.addEnvironment('USER_TABLE_NAME', userTable.tableName);

legacyClaimWorkerLambda.grantInvoke(postConfirmationLambda);
legacyClaimWorkerLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:TransactWriteItems', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
    resources: [userTable.tableArn],
  }),
);

// getUserPublic Lambda wiring (#271). Read-only GetItem on User by
// cognitoSub; the PII filter happens in-handler. USER_TABLE_NAME env
// var lets it address the table without an SDK lookup.
const getUserPublicLambdaFn = backend.getUserPublicLambda.resources.lambda as LambdaFunction;
getUserPublicLambdaFn.addEnvironment('USER_TABLE_NAME', userTable.tableName);
getUserPublicLambdaFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [userTable.tableArn],
  }),
);

// FK fan-out wiring (sub-B of #16 / #273).
//
// The worker sweeps 11 child tables that hold a FK to User and rewrites
// each FK from `legacy:<id>` to the real Cognito sub. Each table needs:
//   - Env var so the worker can address it without an SDK lookup.
//   - Read grant on the FK GSI (or the base table for PK == userId).
//   - Write grant on the base table (TransactWriteItems for chunks of
//     Update / Delete / Put).
//
// Tables fall into three shapes (see `fan-out-legacy-fks.ts`):
//   - simple FK column: Sdr, Comment, AbuseReport, Donation, Recording,
//     TranscriptRevision, User (bannedById).
//   - PK-part FK: FieldVote, RevisionVote.
//   - PK == userId: Reputation, NotificationPreference.
//
// `User` is omitted from `fanOutTableKeys` below because its env var
// (`USER_TABLE_NAME`) was already wired by PR A's setup above + its
// arn is seeded into `fanOutTableArns` at initialisation. The worker's
// `defaultFanOutTableNames` takes the user table name as a function
// parameter rather than via the per-table env var pattern.
const fanOutTableKeys = [
  'Sdr',
  'Comment',
  'AbuseReport',
  'Donation',
  'Recording',
  'TranscriptRevision',
  'FieldVote',
  'RevisionVote',
  'Reputation',
  'NotificationPreference',
] as const;
const envKeyFor: Record<(typeof fanOutTableKeys)[number], string> = {
  Sdr: 'SDR_TABLE_NAME',
  Comment: 'COMMENT_TABLE_NAME',
  AbuseReport: 'ABUSE_REPORT_TABLE_NAME',
  Donation: 'DONATION_TABLE_NAME',
  Recording: 'RECORDING_TABLE_NAME',
  TranscriptRevision: 'TRANSCRIPT_REVISION_TABLE_NAME',
  FieldVote: 'FIELD_VOTE_TABLE_NAME',
  RevisionVote: 'REVISION_VOTE_TABLE_NAME',
  Reputation: 'REPUTATION_TABLE_NAME',
  NotificationPreference: 'NOTIFICATION_PREFERENCE_TABLE_NAME',
};
const fanOutTableArns: string[] = [userTable.tableArn];
for (const key of fanOutTableKeys) {
  const table = backend.data.resources.tables[key];
  if (!table) {
    throw new Error(`backend: ${key} table not found on data resources`);
  }
  legacyClaimWorkerLambda.addEnvironment(envKeyFor[key], table.tableName);
  fanOutTableArns.push(table.tableArn);
}
// Single statement covers every fan-out table. `${arn}/index/*` grants
// Query on all GSIs (we don't enumerate index names because Amplify-
// generated index ARNs aren't directly addressable at synth-time
// without locking in the index naming convention).
legacyClaimWorkerLambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:Query',
      'dynamodb:GetItem',
      'dynamodb:TransactWriteItems',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:UpdateItem',
    ],
    resources: [...fanOutTableArns, ...fanOutTableArns.map((arn) => `${arn}/index/*`)],
  }),
);

// Discord OIDC bridge needs a public HTTPS endpoint so Cognito can hit
// `/.well-known/openid-configuration`, `/authorize`, `/token`, etc. A Lambda
// function URL (no auth) is the cheapest way to expose it — no API Gateway
// markup, no extra request fee.
const discordBridgeUrl = backend.discordOidcBridge.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  invokeMode: InvokeMode.BUFFERED,
});

// Plug the bridge function URL into the Cognito OIDC IdP we declared in
// `auth/resource.ts`. The `discordIssuerUrl` holder is a `Lazy.string`
// produce-target — CDK resolves it at synth, CFN resolves the underlying
// function-URL token at deploy. No hardcoded URL, single deploy (issue #254).
//
// `discordBridgeUrl.url` resolves to e.g. `https://abc.lambda-url.us-east-1.on
// .aws/` (trailing slash). The bridge handler derives its own issuer from
// `event.requestContext.domainName`, which has no scheme and no trailing
// slash, so we strip the trailing slash here to keep the `iss` claim in
// minted id_tokens byte-for-byte identical to what Cognito has registered.
//
// Format assumption: AWS Lambda function URLs are documented as
// `https://<url-id>.lambda-url.<region>.on.aws/`. Splitting on `/` and
// taking index 2 yields the bare host. If AWS ever changes that format
// (e.g. adds a path segment) this extraction breaks at deploy time, not
// silently — Cognito would reject sign-in because the issuer mismatched.
// Revisit then.
const bridgeHost = Fn.select(2, Fn.split('/', discordBridgeUrl.url));
discordIssuerUrl.url = `https://${bridgeHost}`;

// Surface the bridge URL as a stack output so operators / web clients can see
// where the bridge lives without having to crack open the CloudFormation
// console.
backend.addOutput({
  custom: {
    discordOidcBridgeUrl: discordBridgeUrl.url,
  },
});

// Legacy-claim replay sweeper wiring (sub-C of #16 / #274).
//
// The sweeper runs on an EventBridge daily schedule. It Query-s User by
// `claimStatus = CLAIMED`, reads each user's audit manifest, and re-runs
// `fanOutLegacyFks` with `getCompletedTables` so only tables that were
// never fanned out get re-queried.
//
// IAM grants on the sweeper Lambda:
//   - Query on every fan-out table + index (re-uses the same shape as
//     the worker — see `fanOutTableArns` above).
//   - Query on AuditLog by `(targetType, targetId)` GSI to read the
//     per-user manifest.
//   - Query on User by `claimStatus` GSI to list claimed rows.
//   - TransactWriteItems / Put / Delete / Update on every fan-out
//     table so the actual rewrite executes.
const legacyClaimSweeperLambda = backend.legacyClaimReplaySweeper.resources
  .lambda as LambdaFunction;

const auditLogTable = backend.data.resources.tables['AuditLog'];
if (!auditLogTable) {
  throw new Error('backend: AuditLog table not found on data resources');
}
const sweeperTableArns = [...fanOutTableArns, auditLogTable.tableArn];

legacyClaimSweeperLambda.addEnvironment('USER_TABLE_NAME', userTable.tableName);
legacyClaimSweeperLambda.addEnvironment('AUDIT_LOG_TABLE_NAME', auditLogTable.tableName);
for (const key of fanOutTableKeys) {
  const table = backend.data.resources.tables[key];
  if (!table) {
    throw new Error(`backend: ${key} table not found on data resources`);
  }
  legacyClaimSweeperLambda.addEnvironment(envKeyFor[key], table.tableName);
}
legacyClaimSweeperLambda.addToRolePolicy(
  new PolicyStatement({
    // No `dynamodb:Scan` — the sweeper relies on the User.claimStatus
    // GSI + AuditLog.(targetType, targetId) GSI + per-FK GSIs for
    // every read path. Avoid widening this without a concrete need.
    actions: [
      'dynamodb:Query',
      'dynamodb:GetItem',
      'dynamodb:TransactWriteItems',
      'dynamodb:PutItem',
      'dynamodb:DeleteItem',
      'dynamodb:UpdateItem',
    ],
    resources: [...sweeperTableArns, ...sweeperTableArns.map((arn) => `${arn}/index/*`)],
  }),
);

// Daily 03:00 UTC schedule — quiet hours for the broadcast audience,
// so any incidental write traffic the sweep generates lands when the
// rest of the pipeline is idle. Switch to hourly only if backlog
// monitoring shows the daily cadence is leaving claims unfinished.
new Rule(backend.createStack('LegacyClaimSweeperSchedule'), 'DailyReplay', {
  description:
    'Daily replay of legacy-claim fan-out for any User row whose post-confirm worker did not finish (#274).',
  schedule: Schedule.cron({ minute: '0', hour: '3' }),
  targets: [new LambdaTarget(legacyClaimSweeperLambda)],
});

// FieldVote orphan-vote janitor wiring (#270).
//
// Daily 04:00 UTC EventBridge schedule (one hour after the
// legacy-claim sweeper so the two crons never overlap on the data
// stack). Janitor needs:
//   - Scan + DeleteItem on FieldVote.
//   - BatchGetItem on Message.
//   - PutItem on AuditLog (via the helper's IAM-backed Amplify Data
//     client; no direct grant needed here — the helper writes
//     through AppSync with the function's execution role).
const fieldVoteOrphanJanitorLambda = backend.fieldVoteOrphanJanitor.resources
  .lambda as LambdaFunction;
const fieldVoteTable = backend.data.resources.tables['FieldVote'];
const messageTable = backend.data.resources.tables['Message'];
if (!fieldVoteTable) {
  throw new Error('backend: FieldVote table not found on data resources');
}
if (!messageTable) {
  throw new Error('backend: Message table not found on data resources');
}
fieldVoteOrphanJanitorLambda.addEnvironment('FIELD_VOTE_TABLE_NAME', fieldVoteTable.tableName);
fieldVoteOrphanJanitorLambda.addEnvironment('MESSAGE_TABLE_NAME', messageTable.tableName);
// FieldVote: full lifecycle (Scan to find rows, BatchWriteItem to
// delete orphans). Message: read-only (BatchGetItem to verify each
// messageId resolves). Keep the two grants separate so a future
// scope tightening on either side stays surgical.
fieldVoteOrphanJanitorLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteItem'],
    resources: [fieldVoteTable.tableArn],
  }),
);
fieldVoteOrphanJanitorLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:BatchGetItem', 'dynamodb:GetItem'],
    resources: [messageTable.tableArn],
  }),
);

new Rule(backend.createStack('FieldVoteOrphanJanitorSchedule'), 'DailyOrphanSweep', {
  description: 'Daily cleanup of FieldVote rows whose messageId no longer resolves (#270).',
  schedule: Schedule.cron({ minute: '0', hour: '4' }),
  targets: [new LambdaTarget(fieldVoteOrphanJanitorLambda)],
});

// Cost-discipline budget alarms (#7). Lives in its own nested stack so it can
// be removed or replaced without touching the data / function stacks.
attachBudgetAlarms(backend.createStack('BudgetsStack'), readBudgetConfig());
