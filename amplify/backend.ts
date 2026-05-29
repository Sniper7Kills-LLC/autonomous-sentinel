import { defineBackend } from '@aws-amplify/backend';
import { Duration, Fn } from 'aws-cdk-lib';
import {
  type Function as LambdaFunction,
  FunctionUrlAuthType,
  InvokeMode,
  Architecture,
  Code,
  LayerVersion,
} from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Policy, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { auth, discordIssuerUrl } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { preprocess } from './functions/preprocess/resource';
import { linguistic } from './functions/linguistic/resource';
import { postConfirmation } from './functions/postConfirmation/resource';
import { preTokenGeneration } from './functions/preTokenGeneration/resource';
import { preAuth } from './functions/preAuth/resource';
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
import { deployBadge } from './functions/deployBadge/resource';
import { attachBudgetAlarms, attachBudgetThrottleAction, readBudgetConfig } from './budgets';
import { applyCognitoTokenValidity } from './cognito-token-validity';
import { attachStorageLifecycle, readStorageLifecycleConfig } from './storage-lifecycle';
import { attachPipelineQueues } from './pipeline-queues';
import { getConcurrencyCap } from './lambda-concurrency';
import { resolveEcrDigest } from './resolve-ecr-digest';
import { type CfnFunction, DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Size } from 'aws-cdk-lib';

const backend = defineBackend({
  auth,
  data,
  storage,
  preprocess,
  linguistic,
  postConfirmation,
  preTokenGeneration,
  preAuth,
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
  deployBadge,
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

// Cognito token TTL tuning (#333). Pin Cognito's CDK defaults
// explicitly so a future Amplify upgrade can't silently shift the
// rotation cadence. Env-tunable per `cognito-token-validity.ts` so a
// different operator can shorten / lengthen without editing source.
applyCognitoTokenValidity(backend.auth.resources.cfnResources.cfnUserPoolClient);

// preAuth trigger wiring (#335).
//
// REGRESSION FIX (follow-up to #420): the direct User-table read here
// recreated the same CFN nested-stack cycle (auth → data) that the
// preTokenGeneration patch closed. preAuth lives in the `auth` stack
// (Cognito trigger placement) but read DDB from the `data` stack;
// combined with the existing data → auth + storage → auth edges, that
// closed the cycle CDK can't sort. Job 60 still failed after the
// preTokenGeneration fix landed because this second offender was
// untouched. Removing the env var + IAM grant here breaks the
// remaining edge. Banned-user enforcement continues at the AppSync
// resolver / mutation handler layer; the proper re-introduction
// (Cognito custom attribute driven by a User-table DynamoDB stream)
// tracks separately.

// preTokenGeneration trigger wiring (#334).
//
// REGRESSION FIX (#420): the direct Reputation-table read introduced a
// CFN nested-stack cycle (auth → data) that blocked every Amplify
// deploy from job 42 onward. Until the proper repWeight pipeline lands
// (DDB-stream-driven Cognito custom attribute, tracked separately), the
// trigger ships *role only*. The handler still emits `custom:repWeight
// = "1"` for every token so the frontend contract is unchanged; the
// claim is just no longer authoritative until the follow-up lands.
//
// No env var. No IAM grant. No cross-stack ref into `data`.
//
// When re-introducing the real lookup, do not reach for
// `reputationTable.tableArn` / `.tableName` from this site — that's
// exactly the pattern that broke. See #420 for the safe re-introduction
// options.

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
// be removed or replaced without touching the data / function stacks. The
// hard-threshold SNS topic returned here is wired to the Whisper concurrency
// throttle below, after the Whisper Lambda is constructed.
const budgetsStack = backend.createStack('BudgetsStack');
const { hardThresholdTopic: budgetHardThresholdTopic } = attachBudgetAlarms(
  budgetsStack,
  readBudgetConfig(),
);

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
  backend.linguistic.resources.lambda.node.defaultChild as CfnFunction
).reservedConcurrentExecutions = getConcurrencyCap('LINGUISTIC');

// recordingMutations → preprocess queue (pipeline stage 1, #433).
//
// After `submitRecording` creates the Recording row it publishes a
// message to the preprocess SQS queue. The preprocess Lambda pulls
// from the queue and starts the ffmpeg / transcode / status-advance
// flow. Failure to publish does not roll the row back — operators
// can redrive missed messages from the DLQ.
const recordingMutationsLambda = backend.recordingMutations.resources.lambda as LambdaFunction;
recordingMutationsLambda.addEnvironment(
  'PREPROCESS_QUEUE_URL',
  pipelineQueues.preprocess.main.queueUrl,
);
pipelineQueues.preprocess.main.grantSendMessages(recordingMutationsLambda);

// Pre-process Lambda → `recordings/web/*` write grant (#46).
//
// The pre-process Lambda transcodes the original upload into the
// canonical Opus 32 kbps mono playback file. CLAUDE.md → Storage:
// "every recording has two persistent files: the untouched original
// + a single web-canonical derivative". The derivative lives at
// `recordings/web/{recordingId}.opus`; the pre-process Lambda is
// the only writer.
//
// Read access for `recordings/web/*` is wired via `defineStorage`'s
// access map (guest + authenticated read so CloudFront can sign
// URLs). Write happens here so the IAM policy stays narrow — only
// the pre-process execution role can publish into this prefix.
const mediaBucket = backend.storage.resources.bucket;
const preprocessLambda = backend.preprocess.resources.lambda as LambdaFunction;

// ffmpeg layer for the Opus transcode (#503). The static ffmpeg binary
// is fetched + SHA-verified into `amplify/layers/ffmpeg/bin/ffmpeg` by
// `amplify/scripts/fetch-ffmpeg.mjs` (run before synth locally and in
// the Amplify backend build per `amplify.yml`); the LayerVersion zips
// it to `/opt/bin/ffmpeg` at runtime. NOTE: `FFMPEG_PATH` is set in a
// follow-up once the deployed layer is smoke-tested — until then the
// handler keeps the byte-copy fallback, so attaching the layer here is
// inert.
const ffmpegLayer = new LayerVersion(preprocessLambda.stack, 'FfmpegLayer', {
  code: Code.fromAsset('amplify/layers/ffmpeg'),
  compatibleArchitectures: [Architecture.X86_64],
  description: 'Static ffmpeg 8.1.1 (BtbN, LGPL, linux64) for preprocess Opus transcode (#503)',
});
preprocessLambda.addLayers(ffmpegLayer);

preprocessLambda.addEnvironment('MEDIA_BUCKET_NAME', mediaBucket.bucketName);
preprocessLambda.addEnvironment('RECORDINGS_BUCKET', mediaBucket.bucketName);
preprocessLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
    resources: [`${mediaBucket.bucketArn}/recordings/web/*`],
  }),
);
// Read on `recordings/originals/*` so the Lambda can pull the source
// upload before transcoding. Same execution-role grant pattern.
preprocessLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${mediaBucket.bucketArn}/recordings/originals/*`],
  }),
);

// Pipeline stage 2 wiring (#433). The preprocess Lambda consumes the
// preprocess SQS queue (populated by submitRecording), advances the
// Recording row via the Amplify Data client (so AppSync's
// subscription publisher fires for the portal `observeQuery`), and
// publishes onto the transcribe SQS queue. The schema-side
// `allow.resource(preprocess)` grant in `data/resource.ts` injects
// the AMPLIFY_DATA_* env vars + AppSync invoke permission this
// Lambda needs — no direct DDB grant required.
const recordingTable = backend.data.resources.tables['Recording'];
if (!recordingTable) {
  throw new Error('backend: Recording table not found on data resources');
}
preprocessLambda.addEnvironment('TRANSCRIBE_QUEUE_URL', pipelineQueues.transcribe.main.queueUrl);
pipelineQueues.transcribe.main.grantSendMessages(preprocessLambda);
preprocessLambda.addEventSource(
  new SqsEventSource(pipelineQueues.preprocess.main, { batchSize: 1 }),
);

// Whisper container Lambda — self-hosted transcribe backend (#54).
//
// Image build pipeline is SEPARATE per AWS Prescriptive Guidance
// ("Deploy Lambda functions with container images"): dedicated
// CodeBuild project (declared in `infra/whisper-image-pipeline/`)
// listens for `amplify/functions/transcribe-whisper/**` changes
// on `main`, builds + pushes to ECR `autonomous-sentinel/
// whisper-medium`. This Lambda just references the existing
// image via `DockerImageCode.fromEcr`.
//
// Rationale: Amplify Hosting's CodeBuild backing runs with
// `privilegedMode: false` (no docker daemon, not configurable
// via Amplify Hosting public API). Trying to build the image at
// `ampx pipeline-deploy` time fails — verified by job 35
// (`Cannot connect to the Docker daemon`). The dedicated build
// project has its own `privilegedMode: true`.
//
// Tag: `:latest` floats to the most recent CodeBuild push for
// simplicity. Future improvement: pin to git-SHA tag for
// immutability + per-branch image versioning.
//
// Resource sizing per #54 spec + CLAUDE.md → Stack table:
//   - memorySize 3008 MB: medium model (~1.5 GB) + ffmpeg-decoded
//     audio + Node heap. Lambda gets ~2 vCPU at this memory tier.
//   - timeout 15 min: chunker (#59) keeps inputs ≤ 5 min, so a
//     single invoke fits comfortably; headroom covers cold-start +
//     retries.
//   - ephemeralStorage 2048 MB: /tmp holds the Opus download +
//     whisper.cpp JSON output during processing.
//   - RESERVED concurrency only, never provisioned, per CLAUDE.md
//     ("tolerate cold start, no provisioned concurrency"). Cap
//     env-tunable via `CONCURRENCY_TRANSCRIBE_WHISPER_LOCAL`.
//
// IAM:
//   - S3 GetObject on `recordings/web/*` — download canonical Opus.
//   - S3 PutObject on `pipeline-temp/*` — stage whisper.json for
//     the deferred finalizer Lambda to ingest into the Recording
//     row.
//
// SQS:
//   - Subscribes to the transcribe queue from #67 with batchSize=1.
//     One Recording per invoke. The selector dispatcher (#58)
//     fronts this once the other three backends ship — for v1
//     this Lambda is the only consumer.
const transcribeWhisperStack = backend.createStack('TranscribeWhisperStack');
// Look up the ECR repo provisioned by `infra/whisper-image-pipeline/`.
// `fromRepositoryName` makes this a reference, not a CDK-managed
// resource — the pipeline stack owns the lifecycle.
const whisperRepo = Repository.fromRepositoryName(
  transcribeWhisperStack,
  'WhisperRepo',
  'autonomous-sentinel/whisper-medium',
);

// #444: grant the Amplify Hosting deploy role `ecr:DescribeImages`
// on the whisper repo so the synth-time digest resolver
// (`amplify/resolve-ecr-digest.ts`) can read the current digest
// instead of falling back to the literal `latest` tag. Without
// this grant the CDK `Code.ImageUri` value is byte-identical
// across deploys and CFN never rolls the Lambda image forward —
// the exact bug #442 was supposed to fix.
//
// Bootstrap: the deploy that adds this policy still synths
// without the grant in place (CFN applies the policy resource
// after synth completes); the grant takes effect on the
// following deploy. Acceptable because the helper already
// fails soft.
//
// Role name `AutonomousSentinelAmplifyBackendDeploy` is the
// IAM role attached to this Amplify app's backend deployment —
// the same one quoted in Hosting build log job 76 as the
// caller denied `ecr:DescribeImages`.
const amplifyDeployRole = Role.fromRoleName(
  transcribeWhisperStack,
  'AmplifyDeployRoleRef',
  'AutonomousSentinelAmplifyBackendDeploy',
);
new Policy(transcribeWhisperStack, 'WhisperEcrDescribeImagesPolicy', {
  policyName: 'WhisperEcrDescribeImages',
  roles: [amplifyDeployRole],
  statements: [
    new PolicyStatement({
      actions: ['ecr:DescribeImages'],
      resources: [whisperRepo.repositoryArn],
    }),
  ],
});
// `recordingTable` already declared in the stage-2 preprocess wiring
// block higher up — reused here for the Whisper finalizer env + IAM.

// #442: resolve `:latest` to a concrete `sha256:...` digest at synth
// time. `DockerImageCode.fromEcr` writes `tagOrDigest` verbatim into
// the synthesized CFN template; when it's a float tag like `latest`
// the Code.ImageUri property never changes across deploys, so CFN
// never updates the Lambda — even after a fresh image push. Pinning
// the digest makes each deploy that follows a new push roll the
// Lambda forward. Fail-soft: missing creds / missing image returns
// the original tag and synth still succeeds.
const whisperImageTagOrDigest = resolveEcrDigest({
  repositoryName: 'autonomous-sentinel/whisper-medium',
  region: 'us-east-1',
  tag: 'latest',
  fallback: 'latest',
});

const whisperFn = new DockerImageFunction(transcribeWhisperStack, 'TranscribeWhisperFn', {
  code: DockerImageCode.fromEcr(whisperRepo, { tagOrDigest: whisperImageTagOrDigest }),
  memorySize: 3008,
  timeout: Duration.minutes(15),
  ephemeralStorageSize: Size.mebibytes(2048),
  environment: {
    RECORDINGS_BUCKET: mediaBucket.bucketName,
    PIPELINE_TEMP_PREFIX: 'pipeline-temp',
    WHISPER_LANGUAGE: 'en',
    // #452 — all Recording state changes now route through the
    // linguistic Lambda via this queue (success + failure). The
    // container no longer writes to DDB directly.
    LINGUISTIC_QUEUE_URL: pipelineQueues.linguistic.main.queueUrl,
  },
  reservedConcurrentExecutions: getConcurrencyCap('TRANSCRIBE_WHISPER_LOCAL'),
});
whisperFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${mediaBucket.bucketArn}/recordings/web/*`],
  }),
);
// Modern AWS S3 SDK probes the bucket on the error path of a GetObject
// (so a missing-key 404 becomes a 403 instead of leaking existence).
// Without `s3:ListBucket`, even a successful GetObject can surface as
// `AccessDenied for s3:ListBucket on <bucket>`. Scope the grant to the
// `recordings/web/*` prefix so this role can only list its own input
// surface.
whisperFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [mediaBucket.bucketArn],
    conditions: {
      StringLike: { 's3:prefix': ['recordings/web/*'] },
    },
  }),
);
whisperFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
    resources: [`${mediaBucket.bucketArn}/pipeline-temp/*`],
  }),
);
// Word-timestamps sidecar (#92) is written under
// `recordings/web/<id>.words.json` so the web audio player can
// fetch it via the same `allow.guest.to(['read'])` prefix as the
// canonical Opus.
whisperFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
    resources: [`${mediaBucket.bucketArn}/recordings/web/*`],
  }),
);
// #452 — DDB `Recording.UpdateItem` grant removed; Whisper now
// publishes both success + failure to the linguistic queue and
// the linguistic Lambda owns all Recording.update calls via
// Amplify Data so AppSync's subscription publisher fires.
pipelineQueues.linguistic.main.grantSendMessages(whisperFn);
whisperFn.addEventSource(new SqsEventSource(pipelineQueues.transcribe.main, { batchSize: 1 }));

// Budget hard-threshold ($200) → throttle Whisper to concurrency 1 (#7).
// The throttle Lambda lives in BudgetsStack and references the Whisper
// Lambda's name + ARN — one-way dependency, no cycle. Subscribes itself
// to the BudgetHardThresholdTopic created in attachBudgetAlarms above.
attachBudgetThrottleAction(budgetsStack, budgetHardThresholdTopic, whisperFn);

// Deploy-status badge Lambda (#423).
//
// Public Function URL that returns shields.io endpoint JSON
// describing the latest Amplify Hosting deploy for `main`. Embedded
// in README via `https://img.shields.io/endpoint?url=<function-url>`
// so a public reader sees the actual deploy state at a glance.
//
// Grouped with `data` in resource.ts to avoid recreating the
// auth → data CFN cycle that #420 / #424 just closed. The Lambda
// reads via the Amplify SDK (no DDB), so no cross-stack ref is
// introduced by the IAM grant below.
const deployBadgeLambda = backend.deployBadge.resources.lambda as LambdaFunction;
// AMPLIFY_APP_ID is the prod Amplify Hosting app id — public,
// appears in every public Amplify URL, not a secret. Hard-coded
// because CDK doesn't surface it via `backend.*.resources` (Amplify
// Hosting owns the app, separate from the backend resources).
deployBadgeLambda.addEnvironment('AMPLIFY_APP_ID', 'd3p8g0zujguxh4');
deployBadgeLambda.addEnvironment('AMPLIFY_BRANCH', 'main');
deployBadgeLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['amplify:ListJobs'],
    // Wildcard region/account so the policy stays portable; scoped
    // to the prod app id only.
    resources: [`arn:aws:amplify:*:*:apps/d3p8g0zujguxh4/branches/main/jobs/*`],
  }),
);
// Public Function URL — shields.io fetches over HTTPS, no auth.
// CORS defaults from CDK allow `*` origins + GET, which is exactly
// what shields.io needs. Omit `allowedMethods` rather than passing
// an empty array — CFN rejects `Cors.AllowMethods: []` as invalid
// during stack update (caused job 63 to fail).
const deployBadgeUrl = deployBadgeLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: ['*'],
  },
});
backend.addOutput({
  custom: {
    deployBadgeUrl: deployBadgeUrl.url,
  },
});

// Pipeline stage 4 wiring (#433). The linguistic Lambda consumes the
// linguistic SQS queue (populated by the Whisper handler at stage 3),
// classifies the transcript, and routes Message.create + Recording.update
// through the Amplify Data client so AppSync subscriptions fire for the
// portal's `observeQuery`. The schema-side `allow.resource(linguistic)`
// grant in `data/resource.ts` injects the AMPLIFY_DATA_* env vars + the
// AppSync invoke permission — no direct DDB grant required.
const linguisticLambda = backend.linguistic.resources.lambda as LambdaFunction;
linguisticLambda.addEventSource(
  new SqsEventSource(pipelineQueues.linguistic.main, { batchSize: 1 }),
);
