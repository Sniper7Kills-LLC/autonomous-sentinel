import { defineBackend } from '@aws-amplify/backend';
import { Duration, Fn } from 'aws-cdk-lib';
import {
  type Function as LambdaFunction,
  FunctionUrlAuthType,
  InvokeMode,
} from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Queue } from 'aws-cdk-lib/aws-sqs';
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
import { recordingMutations } from './functions/recordingMutations/resource';
import { commentMutations } from './functions/commentMutations/resource';
import { transcriptRevisionMutations } from './functions/transcriptRevisionMutations/resource';
import { getUserPublicLambda } from './functions/getUserPublicLambda/resource';
import { listSdrPublicLambda } from './functions/listSdrPublicLambda/resource';
import { notificationPreferenceMutations } from './functions/notificationPreferenceMutations/resource';
import { listAuditLogPublic } from './functions/listAuditLogPublic/resource';
import { legacyClaimWorker } from './functions/legacyClaimWorker/resource';
import { legacyClaimReplaySweeper } from './functions/legacyClaimReplaySweeper/resource';
import { fieldVoteOrphanJanitor } from './functions/fieldVoteOrphanJanitor/resource';
import { attachBudgetAlarms, readBudgetConfig } from './budgets';
import { attachStorageLifecycle, readStorageLifecycleConfig } from './storage-lifecycle';
import { attachPipelineQueues } from './pipeline-queues';
import { getConcurrencyCap } from './lambda-concurrency';
import type { CfnFunction } from 'aws-cdk-lib/aws-lambda';

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
  recordingMutations,
  commentMutations,
  transcriptRevisionMutations,
  listAuditLogPublic,
  getUserPublicLambda,
  listSdrPublicLambda,
  notificationPreferenceMutations,
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

legacyClaimWorkerLambda.addEnvironment('USER_TABLE_NAME', userTable.tableName);

// Legacy-claim handoff via SQS (#318). The previous direct
// `lambda.grantInvoke` + `LEGACY_CLAIM_WORKER_FUNCTION_NAME` env-var
// from postConfirmation (now in the `auth` stack) into
// legacyClaimWorker (now in the `data` stack) created the residual
// auth ↔ data CDK cross-stack edge that closed the nested-stack
// circular dependency triangle observed at #317. Routing the
// handoff through a queue in its own neutral sub-stack means
//   - auth → LegacyClaimQueueStack (SendMessage env + IAM)
//   - data → LegacyClaimQueueStack (SqsEventSource subscription)
// Both edges flow into the queue stack; the queue stack has no
// outgoing edges. No cycle.
//
// Visibility timeout = 6× the worker's 30 s execution timeout (180 s)
// per AWS best practice. The (maxReceiveCount + 1) × timeout
// fallback also lands above 150 s, so 180 s comfortably covers the
// worst case: a slow run plus retry attempt without delivering the
// same message to a parallel invocation. The worker's own
// idempotency (claim-status conditional check + zero-row fan-out
// when the FK is already rewritten) catches the rare overlap that
// slips through anyway. DLQ caps redrive at 5 attempts; failed
// messages land on `LegacyClaimDeadLetterQueue` for inspection.
const legacyClaimQueueStack = backend.createStack('LegacyClaimQueueStack');
const legacyClaimDlq = new Queue(legacyClaimQueueStack, 'LegacyClaimDeadLetterQueue', {
  retentionPeriod: Duration.days(14),
});
const legacyClaimQueue = new Queue(legacyClaimQueueStack, 'LegacyClaimQueue', {
  visibilityTimeout: Duration.seconds(180),
  retentionPeriod: Duration.days(4),
  deadLetterQueue: { queue: legacyClaimDlq, maxReceiveCount: 5 },
});
postConfirmationLambda.addEnvironment('LEGACY_CLAIM_QUEUE_URL', legacyClaimQueue.queueUrl);
legacyClaimQueue.grantSendMessages(postConfirmationLambda);
// `batchSize: 1` matches the worker's per-record DDB transact +
// fan-out shape (no batch SDK optimisation today). Omit
// `reportBatchItemFailures` — that flag only has effect for
// `batchSize >= 2` where it lets the handler NACK individual
// records via a return value; with `batchSize: 1` an unhandled
// throw already fails the single-record batch and SQS redrives it.
legacyClaimWorkerLambda.addEventSource(new SqsEventSource(legacyClaimQueue, { batchSize: 1 }));

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

// listSdrPublic Lambda wiring (#286). Read-only Scan on the Sdr
// table; granularity blur + publicVisible filter happen in-handler.
// Scan is the right shape for v1 because Sdr row count is bounded by
// the active-user count; switch to a sparse GSI if/when the table
// outgrows single-page Scans. SDR_TABLE_NAME env var addresses the
// table without an SDK lookup.
const sdrTable = backend.data.resources.tables['Sdr'];
if (!sdrTable) {
  throw new Error('backend: Sdr table not found on data resources');
}
const listSdrPublicLambdaFn = backend.listSdrPublicLambda.resources.lambda as LambdaFunction;
listSdrPublicLambdaFn.addEnvironment('SDR_TABLE_NAME', sdrTable.tableName);
listSdrPublicLambdaFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan'],
    resources: [sdrTable.tableArn],
  }),
);

// notificationPreferenceMutations Lambda wiring (#288).
//
// Two responsibilities:
//   1. Dedicated symmetric KMS key — encrypts the user-supplied
//      Discord webhook URL at rest. Lives in its own nested stack
//      (`NotificationPrefKmsStack`) so the key + alias can be
//      rotated / migrated without touching the data stack. Key
//      policy stays at the AWS default (root-account access only);
//      the handler's IAM role is granted Encrypt + Decrypt by the
//      `grantEncryptDecrypt` call below.
//   2. DDB GetItem + UpdateItem on the NotificationPreference table
//      (upsert; lazy-creates the row on first owner read).
//
// `NOTIFICATION_PREFERENCE_TABLE_NAME` is already populated for the
// legacy-claim worker (it fans out the same table). Re-read it from
// the data resources here so the new Lambda doesn't depend on the
// fan-out wiring block executing first.
const notificationPreferenceTable = backend.data.resources.tables['NotificationPreference'];
if (!notificationPreferenceTable) {
  throw new Error('backend: NotificationPreference table not found on data resources');
}
const notificationPrefKmsStack = backend.createStack('NotificationPrefKmsStack');
// No explicit `alias` on the Key — KMS aliases are account-globally
// unique, NOT stack-scoped, so a hardcoded alias collides whenever
// two stacks (e.g. local sandbox + Amplify Hosting branch) deploy
// this same template into the same account (#328 — same class as
// #326's Budgets-name collision). The notificationPreferenceMutations
// Lambda references the key by `keyId` token below, NOT by alias,
// so dropping the alias has no functional impact. A future operator
// who wants a console-readable alias should derive it from
// `Stack.of(scope).stackName` so each environment gets its own.
const notificationPrefKey = new Key(notificationPrefKmsStack, 'NotificationPrefWebhookUrlKey', {
  description:
    'Symmetric KMS key for NotificationPreference.discordWebhookUrl encryption-at-rest (#288).',
  enableKeyRotation: true,
});
const notificationPrefLambda = backend.notificationPreferenceMutations.resources
  .lambda as LambdaFunction;
notificationPrefLambda.addEnvironment(
  'NOTIFICATION_PREFERENCE_TABLE_NAME',
  notificationPreferenceTable.tableName,
);
notificationPrefLambda.addEnvironment('KMS_KEY_ID', notificationPrefKey.keyId);
notificationPrefLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [notificationPreferenceTable.tableArn],
  }),
);
notificationPrefKey.grantEncryptDecrypt(notificationPrefLambda);

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
  'Message',
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
  // #305 — Message.submitterId joins the fan-out set after the
  // recording-less submission flow (#285) gave Message its first
  // User FK.
  Message: 'MESSAGE_TABLE_NAME',
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
//
// The Rule lives in the sweeper Lambda's enclosing stack (the `data`
// stack after the #317 resourceGroupName moves) rather than a
// dedicated `backend.createStack(...)` sub-stack — keeping the
// schedule co-located with the Lambda + the DDB tables it sweeps
// removes a cross-stack reference that contributed to the original
// nested-stack circular dependency.
new Rule(legacyClaimSweeperLambda.stack, 'LegacyClaimSweeperDailyReplay', {
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

// As with the LegacyClaim sweeper above, the Rule lives in the
// janitor Lambda's enclosing stack (the `data` stack after the
// #317 resourceGroupName move) rather than a dedicated
// `backend.createStack(...)` sub-stack.
new Rule(fieldVoteOrphanJanitorLambda.stack, 'FieldVoteOrphanJanitorDailySweep', {
  description: 'Daily cleanup of FieldVote rows whose messageId no longer resolves (#270).',
  schedule: Schedule.cron({ minute: '0', hour: '4' }),
  targets: [new LambdaTarget(fieldVoteOrphanJanitorLambda)],
});

// Cost-discipline budget alarms (#7). Lives in its own nested stack so it can
// be removed or replaced without touching the data / function stacks.
attachBudgetAlarms(backend.createStack('BudgetsStack'), readBudgetConfig());

// S3 lifecycle + versioning + CORS + encryption configuration on
// the media bucket (#44, #45, #47, #48). Applied via L1 escape-hatch
// on the bucket `defineStorage()` creates — surfaces those knobs
// without forcing us to abandon `defineStorage` for a raw `Bucket`
// construct. Default CORS origin set covers localhost + beta.eam.
// watch; production cutover sets `AS_STORAGE_CORS_ORIGINS` to
// include `https://eam.watch` without a code change.
attachStorageLifecycle(backend.storage.resources.bucket, readStorageLifecycleConfig());

// Pipeline SQS queues + DLQs (#67) — the backbone of the
// recording → preprocess → transcribe → linguistic flow. Each
// consumer Lambda (#49-#52, #54-#58, #62-#63) wires its own
// `SqsEventSource` against the matching queue in its own PR; this
// stack stand-up just creates the queues so the rest of the
// pipeline-stage PRs can reference them without circular wiring.
// Queue ARNs surfaced via `backend.addOutput` so the consumer
// Lambdas can read them at runtime + grant themselves receive
// perms at synth time (the typical Amplify Gen 2 cross-stack
// pattern).
const pipelineQueuesStack = backend.createStack('PipelineQueuesStack');
const pipelineQueues = attachPipelineQueues(pipelineQueuesStack);
backend.addOutput({
  custom: {
    preprocessQueueUrl: pipelineQueues.preprocess.main.queueUrl,
    preprocessDlqUrl: pipelineQueues.preprocess.dlq.queueUrl,
    transcribeQueueUrl: pipelineQueues.transcribe.main.queueUrl,
    transcribeDlqUrl: pipelineQueues.transcribe.dlq.queueUrl,
    linguisticQueueUrl: pipelineQueues.linguistic.main.queueUrl,
    linguisticDlqUrl: pipelineQueues.linguistic.dlq.queueUrl,
  },
});

// Per-Lambda reserved-concurrency caps (#68). Bounds the worst-
// case AWS spend from a runaway pipeline stage. Caps are env-
// tunable via `CONCURRENCY_<KEY>` (see `lambda-concurrency.ts`).
// RESERVED only, never provisioned, per CLAUDE.md → Whisper
// container Lambda ("tolerate cold start, no provisioned
// concurrency"). Backends that haven't shipped yet (#54-#57,
// #66 reprocess driver) will wire their own cap in their PR.
(
  backend.preprocess.resources.lambda.node.defaultChild as CfnFunction
).reservedConcurrentExecutions = getConcurrencyCap('PREPROCESS');
(
  backend.transcribe.resources.lambda.node.defaultChild as CfnFunction
).reservedConcurrentExecutions = getConcurrencyCap('TRANSCRIBE_DISPATCH');
(
  backend.linguistic.resources.lambda.node.defaultChild as CfnFunction
).reservedConcurrentExecutions = getConcurrencyCap('LINGUISTIC');
