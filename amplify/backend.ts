import { defineBackend } from '@aws-amplify/backend';
import { Duration, Fn, Stack } from 'aws-cdk-lib';
import {
  type Function as LambdaFunction,
  EventSourceMapping,
  FunctionUrlAuthType,
  InvokeMode,
  StartingPosition,
} from 'aws-cdk-lib/aws-lambda';
import { StreamViewType } from 'aws-cdk-lib/aws-dynamodb';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { SqsEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
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
import { transcribeAws } from './functions/transcribe-aws/resource';
import { transcribeAwsFinalizer } from './functions/transcribe-aws-finalizer/resource';
import { transcribeDispatch } from './functions/transcribe-dispatch/resource';
import {
  BACKEND_ENV_VAR,
  DEFAULT_TRANSCRIBE_BACKEND,
} from './functions/transcribe-dispatch/selector';
import { postConfirmation } from './functions/postConfirmation/resource';
import { preTokenGeneration } from './functions/preTokenGeneration/resource';
import { preAuth } from './functions/preAuth/resource';
import { discordOidcBridge } from './functions/discordOidcBridge/resource';
import { userMutations } from './functions/userMutations/resource';
import { messageMutations } from './functions/messageMutations/resource';
import { recordingMutations } from './functions/recordingMutations/resource';
import { promptTemplateMutations } from './functions/promptTemplateMutations/resource';
import { commentMutations } from './functions/commentMutations/resource';
import { transcriptRevisionMutations } from './functions/transcriptRevisionMutations/resource';
import { getUserPublicLambda } from './functions/getUserPublicLambda/resource';
import { listSdrPublicLambda } from './functions/listSdrPublicLambda/resource';
import { notificationPreferenceMutations } from './functions/notificationPreferenceMutations/resource';
import { listAuditLogPublic } from './functions/listAuditLogPublic/resource';
import { legacyClaimWorker } from './functions/legacyClaimWorker/resource';
import { linguisticConfigStream } from './functions/linguisticConfigStream/resource';
import { legacyClaimReplaySweeper } from './functions/legacyClaimReplaySweeper/resource';
import { fieldVoteOrphanJanitor } from './functions/fieldVoteOrphanJanitor/resource';
import { revisionVoteScoreCron } from './functions/revisionVoteScoreCron/resource';
import { deployBadge } from './functions/deployBadge/resource';
import { costSnapshotWorker } from './functions/costSnapshotWorker/resource';
import { costSnapshotTrigger } from './functions/costSnapshotTrigger/resource';
import { dlqAdmin } from './functions/dlqAdmin/resource';
import { stripeRevenueWorker } from './functions/stripeRevenueWorker/resource';
import { wafSync } from './functions/wafSync/resource';
import { wafMetrics } from './functions/wafMetrics/resource';
import { attachWaf, attachAppSyncWaf, WAF_RESOURCE_NAMES, APPSYNC_WAF_NAMES } from './waf';
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
  transcribeAws,
  transcribeAwsFinalizer,
  transcribeDispatch,
  postConfirmation,
  preTokenGeneration,
  preAuth,
  discordOidcBridge,
  userMutations,
  messageMutations,
  recordingMutations,
  promptTemplateMutations,
  commentMutations,
  transcriptRevisionMutations,
  listAuditLogPublic,
  getUserPublicLambda,
  listSdrPublicLambda,
  notificationPreferenceMutations,
  legacyClaimWorker,
  legacyClaimReplaySweeper,
  fieldVoteOrphanJanitor,
  revisionVoteScoreCron,
  linguisticConfigStream,
  deployBadge,
  costSnapshotWorker,
  costSnapshotTrigger,
  dlqAdmin,
  stripeRevenueWorker,
  wafSync,
  wafMetrics,
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

// promptTemplateMutations Lambda wiring (#572).
//
// The Lambda resolves `activatePromptTemplate` + `savePromptTemplateVersion`
// directly against the LinguisticPromptTemplate table (Scan/GetItem to
// resolve the active row + version max, PutItem for the conditional
// version create, TransactWriteItems for the atomic activation flip).
// Same direct-DDB shape as notificationPreferenceMutations above; grouped
// with `data` (resourceGroupName) so no FunctionDirectiveStack ↔ data cycle.
const linguisticPromptTemplateTable = backend.data.resources.tables['LinguisticPromptTemplate'];
if (!linguisticPromptTemplateTable) {
  throw new Error('backend: LinguisticPromptTemplate table not found on data resources');
}
const promptTemplateLambda = backend.promptTemplateMutations.resources.lambda as LambdaFunction;
promptTemplateLambda.addEnvironment(
  'LINGUISTIC_PROMPT_TEMPLATE_TABLE_NAME',
  linguisticPromptTemplateTable.tableName,
);
promptTemplateLambda.addToRolePolicy(
  new PolicyStatement({
    // TransactWriteItems requires the underlying PutItem/UpdateItem
    // permissions; Scan + GetItem cover the active-row + version-max
    // resolution.
    actions: ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [linguisticPromptTemplateTable.tableArn],
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

// Revision voteScore recompute cron (#653).
//
// Recomputes `TranscriptRevision.voteScore` from the live RevisionVote rows
// on a schedule (every 30 min) rather than via a DDB stream — a stream
// consumer on RevisionVote (which carries the castRevisionVote resolver)
// closes a CFN cycle that sandbox can't catch (reverted #658/#661). Raw DDB
// only — Scan RevisionVote + UpdateItem TranscriptRevision, both intra-data-
// stack grants, no allow.resource — so it is cycle-safe like the janitor.
const revisionVoteScoreCronLambda = backend.revisionVoteScoreCron.resources
  .lambda as LambdaFunction;
const revisionVoteTableForCron = backend.data.resources.tables['RevisionVote'];
const transcriptRevisionTableForCron = backend.data.resources.tables['TranscriptRevision'];
if (!revisionVoteTableForCron || !transcriptRevisionTableForCron) {
  throw new Error('backend: RevisionVote / TranscriptRevision table not found for voteScore cron');
}
revisionVoteScoreCronLambda.addEnvironment(
  'REVISION_VOTE_TABLE_NAME',
  revisionVoteTableForCron.tableName,
);
revisionVoteScoreCronLambda.addEnvironment(
  'TRANSCRIPT_REVISION_TABLE_NAME',
  transcriptRevisionTableForCron.tableName,
);
revisionVoteScoreCronLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan'],
    resources: [revisionVoteTableForCron.tableArn],
  }),
);
revisionVoteScoreCronLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [transcriptRevisionTableForCron.tableArn],
  }),
);
new Rule(revisionVoteScoreCronLambda.stack, 'RevisionVoteScoreRecompute', {
  description: 'Recompute TranscriptRevision.voteScore from RevisionVote rows every 30 min (#653).',
  schedule: Schedule.rate(Duration.minutes(30)),
  targets: [new LambdaTarget(revisionVoteScoreCronLambda)],
});

// Cost-transparency snapshot worker wiring (#303).
//
// Daily 05:00 UTC EventBridge schedule — one hour after the FieldVote
// janitor (04:00) and two after the legacy-claim sweeper (03:00) so the
// three data-stack crons never overlap. Cost Explorer reports the
// previous fully-settled UTC day, so 05:00 leaves margin for that day
// to settle.
//
// The worker pulls Cost Explorer and writes CostSnapshot rows via the
// DDB SDK:
//   - Cost Explorer GetCostAndUsage (GroupBy=SERVICE) → AWS_SERVICE rows
//
// CFN-cycle root cause (resolved here, #644): the worker MUST carry ZERO
// cross-stack token references, exactly like the working
// `fieldVoteOrphanJanitor` (table names only) and AVGN's `billingSnapshot`
// (table name + `ce:*` wildcard). Earlier revisions added
// `MEDIA_BUCKET_NAME = storage.bucket.bucketName` (storage→data) and
// `COST_LAMBDA_FUNCTION_NAMES` containing `preprocess.functionName`
// (function→data). The function stack already imports from the data stack,
// so a data→function reference closed a CloudFormation cycle that surfaced
// as `[costSnapshotWorker, CostSnapshotDaily, AllowEventRule]` in the data
// stack — even cron-only, with no resolver binding. Switching to wildcard
// IAM alone (job 181) did NOT fix it because the env tokens remained.
//
// Cost Explorer's per-SERVICE breakdown already surfaces S3, Lambda,
// DynamoDB and every other service's spend, so the transparency page stays
// meaningful. The handler's CloudWatch per-function and S3 per-prefix
// sources self-guard on the (now absent) env vars and emit no rows —
// they can return behind a runtime config (SSM, not a CFN token) later.
//
// Env + scoped IAM (cross-stack-token-free):
//   - COST_SNAPSHOT_TABLE_NAME → the CostSnapshot table name (intra-data).
//   - ce:GetCostAndUsage       → account-wide (Cost Explorer has no
//                                resource-level scoping).
//   - CostSnapshot writes      → grantWriteData (intra-data-stack grant).
const costSnapshotTable = backend.data.resources.tables['CostSnapshot'];
if (!costSnapshotTable) {
  throw new Error('backend: CostSnapshot table not found on data resources');
}
const costSnapshotWorkerLambda = backend.costSnapshotWorker.resources.lambda as LambdaFunction;
costSnapshotWorkerLambda.addEnvironment('COST_SNAPSHOT_TABLE_NAME', costSnapshotTable.tableName);
costSnapshotWorkerLambda.addToRolePolicy(
  new PolicyStatement({
    // Cost Explorer GetCostAndUsage is an account-scoped API — it does
    // not support resource-level ARNs, so `*` is the tightest grant
    // available (matches AVGN's billingSnapshot worker).
    actions: ['ce:GetCostAndUsage'],
    resources: ['*'],
  }),
);
// DDB writes use an intra-data-stack grant (the CostSnapshot table lives
// in the data stack, same stack as the worker via resourceGroupName:'data'),
// avoiding a cross-stack table-ARN import — mirrors AVGN's grantWriteData.
costSnapshotTable.grantWriteData(costSnapshotWorkerLambda);
new Rule(costSnapshotWorkerLambda.stack, 'CostSnapshotDaily', {
  description: 'Daily AWS-spend snapshot for the public /transparency page (#303).',
  schedule: Schedule.cron({ minute: '0', hour: '5' }),
  targets: [new LambdaTarget(costSnapshotWorkerLambda)],
});

// On-demand cost-sync via SQS decouple (#644).
//
// The admin "Sync now" button calls the `runCostSnapshotNow` mutation,
// resolved by `costSnapshotTrigger` (the resolver). The trigger does ONE
// `sqs:SendMessage` to this queue and returns `{ status: 'queued' }`. The
// worker — already a cron target above — also subscribes to this queue as an
// SQS event source. Both the cron and the SQS message run the identical
// snapshot core.
//
// Why this avoids the CFN cycle: the worker stays a pure event-source
// consumer (cron rule + SQS source), exactly like `legacyClaimWorker`. It is
// NEVER an AppSync resolver, so it never enters the FunctionDirectiveStack —
// no FunctionDirectiveStack↔data cross-reference. The trigger IS the resolver
// but references only the queue URL (no worker ARN/name). Both edges flow
// into the neutral queue sub-stack, which has no outgoing edges. Mirrors the
// proven `postConfirmation → legacyClaimQueue → legacyClaimWorker` hand-off.
//
// Visibility timeout = 6× the worker's 60 s execution timeout (360 s) per AWS
// best practice; DLQ caps redrive at 5 attempts.
const costSnapshotQueueStack = backend.createStack('CostSnapshotQueueStack');
const costSnapshotDlq = new Queue(costSnapshotQueueStack, 'CostSnapshotDeadLetterQueue', {
  retentionPeriod: Duration.days(14),
});
const costSnapshotQueue = new Queue(costSnapshotQueueStack, 'CostSnapshotQueue', {
  visibilityTimeout: Duration.seconds(360),
  retentionPeriod: Duration.days(4),
  deadLetterQueue: { queue: costSnapshotDlq, maxReceiveCount: 5 },
});
// Trigger (resolver) → queue: SendMessage env + IAM. No worker reference.
const costSnapshotTriggerLambda = backend.costSnapshotTrigger.resources.lambda as LambdaFunction;
costSnapshotTriggerLambda.addEnvironment('COST_SNAPSHOT_QUEUE_URL', costSnapshotQueue.queueUrl);
costSnapshotQueue.grantSendMessages(costSnapshotTriggerLambda);
// Worker (consumer) → queue: SQS event source. `batchSize: 1` — one snapshot
// run per message, same shape as legacyClaimWorker. The worker keeps its
// single CostSnapshotDaily cron rule above; this only adds the second event
// source. The worker is NOT made a resolver.
costSnapshotWorkerLambda.addEventSource(new SqsEventSource(costSnapshotQueue, { batchSize: 1 }));

// Stripe revenue worker — STUB cron (#303; deferral #206 / #208).
//
// Same daily cadence (05:00 UTC) but the handler writes nothing live
// (no Stripe SDK call). The cron exists so the wiring is proven; the
// RevenueSnapshot table stays empty until Stripe ships. No IAM grant +
// no env var — the stub touches no AWS resource.
const stripeRevenueWorkerLambda = backend.stripeRevenueWorker.resources.lambda as LambdaFunction;
new Rule(stripeRevenueWorkerLambda.stack, 'StripeRevenueDaily', {
  description:
    'STUB daily Stripe revenue snapshot — deferred until donations ship (#303/#206/#208).',
  schedule: Schedule.cron({ minute: '0', hour: '5' }),
  targets: [new LambdaTarget(stripeRevenueWorkerLambda)],
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

// Admin DLQ + manual-reprocess resolver wiring (#107).
//
// `dlqAdmin` is the AppSync resolver behind `listDlqMessages` /
// `requeueDlqMessage` / `dropDlqMessage`. It lives in the data stack
// (resourceGroupName:'data'); these grants reference the neutral
// `PipelineQueuesStack` queues only — a one-way function → queue-stack
// edge that does NOT close a CloudFormation cycle (the queue stack has
// no outgoing edges). AuditLog + Recording writes flow through the
// Amplify Data client via the schema-level `allow.resource(dlqAdmin)`
// grant in data/resource.ts, so no cross-stack DDB table ARN is imported
// here.
//
// Per stage:
//   - DLQ: grantConsumeMessages → ReceiveMessage (peek) + DeleteMessage
//     (requeue/drop) + GetQueueAttributes.
//   - primary queue: grantSendMessages → requeue re-enqueue.
const dlqAdminLambda = backend.dlqAdmin.resources.lambda as LambdaFunction;
const dlqStageEnv: Record<keyof typeof pipelineQueues, { main: string; dlq: string }> = {
  preprocess: { main: 'PREPROCESS_QUEUE_URL', dlq: 'PREPROCESS_DLQ_URL' },
  transcribe: { main: 'TRANSCRIBE_QUEUE_URL', dlq: 'TRANSCRIBE_DLQ_URL' },
  linguistic: { main: 'LINGUISTIC_QUEUE_URL', dlq: 'LINGUISTIC_DLQ_URL' },
};
(Object.keys(dlqStageEnv) as (keyof typeof pipelineQueues)[]).forEach((stage) => {
  const { main, dlq } = pipelineQueues[stage];
  dlqAdminLambda.addEnvironment(dlqStageEnv[stage].main, main.queueUrl);
  dlqAdminLambda.addEnvironment(dlqStageEnv[stage].dlq, dlq.queueUrl);
  dlq.grantConsumeMessages(dlqAdminLambda);
  main.grantSendMessages(dlqAdminLambda);
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

// recordingMutations → linguistic queue (#566 reparseRecording).
//
// `reparseRecording` re-runs ONLY the linguistic stage on a recording's
// stored transcript, skipping preprocess + transcribe. It publishes the
// same TranscriptQueueMessage shape the Whisper container emits straight
// onto the linguistic queue, so the existing classifier + dedup +
// supersede path (#454/#556) runs unchanged. Failure to publish surfaces
// to the caller (the mutation has nothing else to do), unlike the
// fire-and-forget preprocess kick-off.
recordingMutationsLambda.addEnvironment(
  'LINGUISTIC_QUEUE_URL',
  pipelineQueues.linguistic.main.queueUrl,
);
pipelineQueues.linguistic.main.grantSendMessages(recordingMutationsLambda);

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

// recordingMutations → S3 hard-delete / restore on the recordings prefix (#478).
//
// `softDeleteRecording` issues DeleteObject on the recording's original /
// web-canonical / sidecar keys after the row update — versioning (on per
// storage-lifecycle.ts) turns each into a delete-marker, so the prior
// version stays restorable for the 30-day noncurrent-version window.
// `restoreRecording` reverses it by deleting that delete-marker version,
// which needs `s3:DeleteObjectVersion` + `s3:ListBucketVersions` (to find
// the marker's versionId). Scoped to `recordings/*`.
recordingMutationsLambda.addEnvironment('MEDIA_BUCKET_NAME', mediaBucket.bucketName);
recordingMutationsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: [`${mediaBucket.bucketArn}/recordings/*`],
  }),
);
recordingMutationsLambda.addToRolePolicy(
  new PolicyStatement({
    // ListBucketVersions is a bucket-level action; restore needs it to
    // resolve the delete-marker's versionId before removing it.
    actions: ['s3:ListBucketVersions'],
    resources: [mediaBucket.bucketArn],
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
//   - memorySize 10240 MB (Lambda max): medium model (~1.5 GB) +
//     ffmpeg-decoded audio + Node heap. Lambda vCPU scales with the
//     memory tier — ~6 vCPU here vs ~2 at the old 3008 MB. Bumped after
//     a ~4-min clip hit the 900 s timeout AND near-OOM (2997/3008 MB)
//     on CPU transcription (#563); more vCPU ≈ 3× throughput. 900 s is
//     the Lambda hard max, so the only lever for long clips is CPU.
//   - timeout 15 min (the Lambda hard maximum): the chunker (#59) is
//     meant to keep inputs ≤ 5 min, but even a single sub-5-min clip
//     can exceed 900 s on CPU at the old memory tier — hence the bump.
//     Hours-long recordings still need finer chunking (tracked apart).
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
  memorySize: 10240,
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
    resources: [backend.storage.resources.bucket.bucketArn],
    conditions: {
      // `recordings/originals/*` added for the consolidated transcode
      // path (#514): the container downloads the original before
      // transcoding to the web-canonical Opus.
      StringLike: { 's3:prefix': ['recordings/web/*', 'recordings/originals/*'] },
    },
  }),
);
// Read the original upload so the container can transcode it to the
// web-canonical Opus in one pass (#514).
whisperFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${mediaBucket.bucketArn}/recordings/originals/*`],
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
// #587: the whisper container no longer subscribes to the transcribe
// queue directly. The transcribe-dispatch Lambda is now the queue's
// sole consumer; it resolves the backend (`selector.ts`) and async
// (Event) Lambda-invokes whisper (the default) or amazon-transcribe.
// Whisper's handler accepts the dispatch-message body as a direct Event
// payload (in addition to the legacy SQS shape) — see
// `transcribe-whisper/handler.mjs` `normalizeMessages`. The dispatcher
// stack + wiring live in the Transcribe-dispatch block below.

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

// LinguisticRule rules-engine reads (#62/#460). `load-rules-ddb.ts`
// Scans the LinguisticRule table directly via the DDB SDK (the engine
// caches the result per cold start, TTL-refreshed), so the handler
// needs the table name + a Scan grant. This is separate from the
// AppSync Amplify Data path used for Message/Recording writes. With no
// seeded rules the engine returns no match and the handler falls back
// to its inline classifier — non-regressive until rules are curated.
const linguisticRuleTable = backend.data.resources.tables['LinguisticRule'];
if (!linguisticRuleTable) {
  throw new Error('backend: LinguisticRule table not found on data resources');
}
linguisticLambda.addEnvironment('LINGUISTIC_RULE_TABLE_NAME', linguisticRuleTable.tableName);
linguisticLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Scan'],
    resources: [linguisticRuleTable.tableArn],
  }),
);

// Low-confidence escalation re-enqueue (#588 / epic #582). When a whisper
// transcript lands BELOW the admin-tunable threshold, the linguistic Lambda
// re-enqueues the recording onto the TRANSCRIBE queue with
// `backendOverride: 'amazon-transcribe'` so the dispatcher (#587/#589)
// produces a second independent ASR pass that the Bedrock reconcile then
// merges. Fire-and-forget: it never blocks the current whisper publish.
//
// CFN-cycle note: `pipelineQueues.transcribe.main` lives in the neutral
// `PipelineQueuesStack` (no outgoing edges). The linguistic Lambda already
// consumes `pipelineQueues.linguistic.main` from that same stack as its
// event source, so a SendMessage grant + env var on the SIBLING transcribe
// queue adds no NEW cross-stack edge — the linguistic↔PipelineQueuesStack
// edge already exists. No `data`-stack table/construct is referenced here.
linguisticLambda.addEnvironment('TRANSCRIBE_QUEUE_URL', pipelineQueues.transcribe.main.queueUrl);
pipelineQueues.transcribe.main.grantSendMessages(linguisticLambda);
// Admin-tunable escalation threshold default (#588) — overridable per env;
// the LinguisticConfig `WHISPER_ESCALATION_THRESHOLD` row wins at runtime.
linguisticLambda.addEnvironment(
  'WHISPER_ESCALATION_THRESHOLD',
  process.env.WHISPER_ESCALATION_THRESHOLD ?? '0.6',
);

// Bedrock AI fallback (#63/#460). The handler calls the Converse API on
// the configured Anthropic model only when the rules engine + inline
// classifier both miss — so model spend is reserved for genuinely
// unrecognized transcripts. Per CLAUDE.md the AI provider stays in AWS
// (Bedrock). The model is admin-tunable via `LINGUISTIC_FALLBACK_MODEL_ID`.
//
// Grant scoped to Anthropic foundation models + this account's
// inference profiles (Claude Sonnet 4.x is invoked via a cross-region
// inference profile in us-east-1). Bedrock ARNs are external resources,
// so no cross-stack edge / CFN cycle.
const linguisticStack = Stack.of(linguisticLambda);
linguisticLambda.addEnvironment(
  'LINGUISTIC_FALLBACK_MODEL_ID',
  process.env.LINGUISTIC_FALLBACK_MODEL_ID ?? 'us.anthropic.claude-opus-4-8',
);
linguisticLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      `arn:aws:bedrock:*::foundation-model/anthropic.*`,
      `arn:aws:bedrock:*:${linguisticStack.account}:inference-profile/*`,
    ],
  }),
);

// LinguisticConfig audit + reprocess-on-bump wiring (#481).
//
// A DynamoDB stream on the LinguisticConfig table drives the
// `linguisticConfigStream` Lambda: it emits a `LINGUISTIC_CONFIG_UPDATE`
// audit row on every change and, when a `*_PROMPT_VERSION` key's version
// increases, enqueues reprocess jobs for previously-failed Recordings.
//
// Circular-dependency shape (mirrors the legacy-claim queue, #317):
//   - The Lambda is in `resourceGroupName: 'data'`, so the table-stream →
//     Lambda edge stays inside the data stack (no cross-stack edge).
//   - The reprocess queue lives in its own neutral sub-stack. The data
//     stack points at it (SendMessage); the queue stack has no outgoing
//     edges. No cycle.
//   - AuditLog.create + Recording.list go through the Amplify Data IAM
//     client (granted via `allow.resource(linguisticConfigStream)` in
//     `data/resource.ts`) — no direct DDB grant needed.
const reprocessQueueStack = backend.createStack('ReprocessQueueStack');
const reprocessDlq = new Queue(reprocessQueueStack, 'LinguisticReprocessDeadLetterQueue', {
  retentionPeriod: Duration.days(14),
});
const reprocessQueue = new Queue(reprocessQueueStack, 'LinguisticReprocessQueue', {
  // No consumer ships here — the reprocess worker lands with #460. The
  // 4-day retention covers the gap; bumps enqueued before the consumer
  // exists are picked up once it does (or expire harmlessly).
  retentionPeriod: Duration.days(4),
  deadLetterQueue: { queue: reprocessDlq, maxReceiveCount: 3 },
});

const linguisticConfigStreamLambda = backend.linguisticConfigStream.resources
  .lambda as LambdaFunction;
linguisticConfigStreamLambda.addEnvironment('REPROCESS_QUEUE_URL', reprocessQueue.queueUrl);
reprocessQueue.grantSendMessages(linguisticConfigStreamLambda);

// Enable the DynamoDB stream on the LinguisticConfig table and subscribe
// the Lambda — the official Amplify Gen 2 stream pattern (manual
// EventSourceMapping + stream-read IAM policy, since the Amplify table is
// a custom resource).
const linguisticConfigTable = backend.data.resources.tables['LinguisticConfig'];
if (!linguisticConfigTable) {
  throw new Error('backend: LinguisticConfig table not found on data resources');
}
const linguisticConfigCfnTable =
  backend.data.resources.cfnResources.amplifyDynamoDbTables['LinguisticConfig'];
if (!linguisticConfigCfnTable) {
  throw new Error('backend: LinguisticConfig CFN table wrapper not found on data resources');
}
linguisticConfigCfnTable.streamSpecification = {
  streamViewType: StreamViewType.NEW_AND_OLD_IMAGES,
};
// With the stream enabled above, the Amplify table exposes its stream
// ARN. Fail loud at synth if it didn't populate — feeding an undefined
// `eventSourceArn` to the EventSourceMapping below would otherwise
// produce a confusing CFN error far from the cause.
const linguisticConfigStreamArn = linguisticConfigTable.tableStreamArn;
if (!linguisticConfigStreamArn) {
  throw new Error(
    'backend: LinguisticConfig table stream ARN unavailable after enabling streamSpecification',
  );
}
const reprocessStreamPolicy = new Policy(
  Stack.of(linguisticConfigTable),
  'LinguisticConfigStreamReadPolicy',
  {
    statements: [
      new PolicyStatement({
        actions: [
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
          'dynamodb:ListStreams',
        ],
        resources: [linguisticConfigStreamArn],
      }),
    ],
  },
);
linguisticConfigStreamLambda.role?.attachInlinePolicy(reprocessStreamPolicy);
const linguisticConfigStreamMapping = new EventSourceMapping(
  Stack.of(linguisticConfigTable),
  'LinguisticConfigStreamMapping',
  {
    target: linguisticConfigStreamLambda,
    eventSourceArn: linguisticConfigStreamArn,
    startingPosition: StartingPosition.LATEST,
    // Small table, low write rate — single-record batches keep the
    // audit + reprocess logic simple and let a poison record fail in
    // isolation.
    batchSize: 1,
    retryAttempts: 3,
  },
);
linguisticConfigStreamMapping.node.addDependency(reprocessStreamPolicy);

backend.addOutput({
  custom: {
    linguisticReprocessQueueUrl: reprocessQueue.queueUrl,
    linguisticReprocessDlqUrl: reprocessDlq.queueUrl,
  },
});

// Amazon Transcribe backend (c) + async finalizer (#585, epic #582).
//
// Two Lambdas, both in a dedicated `backend.createStack` so their
// EventBridge rule + cross-resource refs (media bucket, linguistic
// queue, Callsign table) don't close a nested-stack CFN cycle (per
// project memory: iterate cycle fixes via `ampx sandbox --once`).
//
// Flow once the #582b dispatcher lands:
//   dispatcher --Event invoke--> transcribeAws --StartTranscriptionJob-->
//     Amazon Transcribe --(EventBridge "Transcribe Job State Change")-->
//       transcribeAwsFinalizer --SendMessage--> linguistic queue
//
// DEFERRED to #582b: the backend Lambda is NOT subscribed to the
// transcribe SQS queue here. The #582b dispatcher owns routing a
// recording to the chosen backend (it resolves the backend ARN via
// `transcribe-dispatch/selector.ts` and Event-invokes it). Until then
// this Lambda is deployable-but-unsubscribed — admins/tests can invoke
// it directly with a `{recordingId, audioKey, enqueuedAt}` payload.
// The escalation gate (#582c) is also out of scope.
const transcribeAwsStack = backend.createStack('TranscribeAwsStack');
const transcribeAwsFn = backend.transcribeAws.resources.lambda as LambdaFunction;
const transcribeAwsFinalizerFn = backend.transcribeAwsFinalizer.resources.lambda as LambdaFunction;

// Reserved-concurrency cap (#68) — bounds worst-case Transcribe spend
// from a runaway pipeline. Env-tunable via `CONCURRENCY_TRANSCRIBE_AMAZON`.
(transcribeAwsFn.node.defaultChild as CfnFunction).reservedConcurrentExecutions =
  getConcurrencyCap('TRANSCRIBE_AMAZON');

// --- backend Lambda env + IAM ---------------------------------------
transcribeAwsFn.addEnvironment('RECORDINGS_BUCKET', mediaBucket.bucketName);
transcribeAwsFn.addEnvironment('PIPELINE_TEMP_PREFIX', 'pipeline-temp');

// Callsign dictionary → custom vocabulary: NOT wired here (#590).
// Referencing the `data`-stack Callsign table (env name + Scan grant)
// from this function added a `function → data` edge that closed a
// nested-stack CFN circular dependency [TranscribeAwsStack, data,
// function] — the hosting `pipeline-deploy` (and a full `ampx sandbox
// --once`) fail to synth. The custom vocabulary is best-effort and the
// high-value terms are STATIC (BASE_VOCAB = NATO alphabet + digit words
// + collective callsigns + EAM prowords), so with `CALLSIGN_TABLE_NAME`
// unset the handler builds the base+proword vocab and still transcribes.
// Re-introducing the dynamic per-account callsigns without the
// cross-stack edge (e.g. routing the load through the dispatcher's data
// access, or a string-ARN grant) is a follow-up under #590.

// Transcribe control-plane: start jobs, poll a job (finalizer / future
// dispatcher), and manage the callsign custom vocabulary. Job + vocab
// names are account/region-scoped strings, not ARNs Transcribe exposes
// for resource-level IAM, so the resource is `*` (standard for these
// Transcribe actions).
transcribeAwsFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'transcribe:StartTranscriptionJob',
      'transcribe:GetTranscriptionJob',
      'transcribe:CreateVocabulary',
      'transcribe:GetVocabulary',
    ],
    resources: ['*'],
  }),
);

// We call StartTranscriptionJob / CreateVocabulary WITHOUT a
// DataAccessRoleArn, so Amazon Transcribe reads the input audio, reads
// the table-format vocabulary TSV, and writes the output JSON using
// THIS Lambda's role. Grant:
//   - GetObject on the audio prefixes (dispatcher passes the ORIGINAL
//     upload key for max quality; web-canonical allowed for an admin
//     re-run on the derivative) AND on `pipeline-temp/*` (Transcribe
//     reads the staged vocab table file at CreateVocabulary time).
//   - PutObject on `pipeline-temp/*` (the handler stages the vocab TSV
//     there; Transcribe also writes the job output JSON there).
transcribeAwsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [
      `${mediaBucket.bucketArn}/recordings/originals/*`,
      `${mediaBucket.bucketArn}/recordings/web/*`,
      `${mediaBucket.bucketArn}/pipeline-temp/*`,
    ],
  }),
);
transcribeAwsFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:PutObject'],
    resources: [`${mediaBucket.bucketArn}/pipeline-temp/*`],
  }),
);

// --- finalizer Lambda env + IAM -------------------------------------
transcribeAwsFinalizerFn.addEnvironment('RECORDINGS_BUCKET', mediaBucket.bucketName);
transcribeAwsFinalizerFn.addEnvironment('PIPELINE_TEMP_PREFIX', 'pipeline-temp');
transcribeAwsFinalizerFn.addEnvironment(
  'LINGUISTIC_QUEUE_URL',
  pipelineQueues.linguistic.main.queueUrl,
);
// Read the job output JSON; publish the canonical transcript/failure
// to the linguistic queue (the linguistic Lambda owns all Recording
// writes so the portal subscription fires — same contract as Whisper).
transcribeAwsFinalizerFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${mediaBucket.bucketArn}/pipeline-temp/*`],
  }),
);
pipelineQueues.linguistic.main.grantSendMessages(transcribeAwsFinalizerFn);

// EventBridge rule: Amazon Transcribe emits a "Transcribe Job State
// Change" event on every job transition. Scope to terminal states so
// the finalizer only fires once per job. The rule lives in the
// dedicated stack alongside the finalizer — no cross-stack edge, no
// cycle. `aws.transcribe` events land on the default event bus
// automatically (no bus wiring needed).
new Rule(transcribeAwsStack, 'TranscribeJobStateChangeRule', {
  description:
    'Routes Amazon Transcribe COMPLETED/FAILED job-state events to the transcribe-aws finalizer (#585).',
  eventPattern: {
    source: ['aws.transcribe'],
    detailType: ['Transcribe Job State Change'],
    detail: {
      TranscriptionJobStatus: ['COMPLETED', 'FAILED'],
    },
  },
  targets: [new LambdaTarget(transcribeAwsFinalizerFn)],
});

// Transcribe-dispatch Lambda (#587, epic #582 slice 2).
//
// The transcribe queue's SOLE consumer. It resolves the active backend
// per message (`transcribe-dispatch/selector.ts`: per-message
// `backendOverride` → admin `DEFAULT_TRANSCRIBE_BACKEND` → hard-coded
// `whisper-local`) and async (Event) Lambda-invokes that backend with
// the message body. Replaces the old direct
// `whisperFn.addEventSource(transcribe queue)` subscription — the whisper
// container + the amazon-transcribe backend are now Event-invoked by ARN.
//
// Cycle avoidance (project memory: iterate via `ampx sandbox --once`).
//
// The dispatcher is assigned to the `data` resource group
// (`resourceGroupName: 'data'` in resource.ts) so its Lambda lands in
// the SAME nested stack as the Amplify Data resolvers — the assignment
// the CFN `CloudformationStackCircularDependencyError` resolution text
// recommends, and the same group `linguistic` / `commentMutations` use.
// Keeping the dispatcher's backend-invoke + transcribe-queue-consume
// edges in the `data` stack (rather than letting `defineFunction` drop
// it into the shared `function` stack, which would route those edges
// through the `function`↔`data`↔`TranscribeAwsStack` triangle) keeps
// THIS change's footprint cycle-neutral.
//
// References are proper CDK constructs throughout — `fn.functionArn`
// tokens + `fn.grantInvoke(dispatcher)` — never hand-built ARN strings.
//
// NOTE: a `ampx sandbox --once` synth surfaces a PRE-EXISTING nested-
// stack cycle `[TranscribeAwsStack, data, function]` that reproduces on
// `main` (#586) WITHOUT this change. With this change the reported cycle
// set is byte-identical to the base — the dispatcher's `data`-group
// placement adds nothing to it. That base cycle is a separate P0 tracked
// on the PR; this slice is not blocked on it.
const transcribeDispatchFn = backend.transcribeDispatch.resources.lambda as LambdaFunction;

// Env: one `*_FN_ARN` per wired backend (the `BACKEND_ENV_VAR` map) +
// the env-wide admin default. Only the two backends that exist today are
// wired; whisper-api + bedrock fall through to the default until their
// Lambdas ship (the selector warns + defaults on a request for an
// unwired backend).
transcribeDispatchFn.addEnvironment(BACKEND_ENV_VAR['whisper-local'], whisperFn.functionArn);
transcribeDispatchFn.addEnvironment(
  BACKEND_ENV_VAR['amazon-transcribe'],
  transcribeAwsFn.functionArn,
);
// Keep the default `whisper-local` so the existing happy path is
// behaviourally unchanged — a recording with no override + no admin
// config still goes to the whisper container.
transcribeDispatchFn.addEnvironment('DEFAULT_TRANSCRIBE_BACKEND', DEFAULT_TRANSCRIBE_BACKEND);

// `lambda:InvokeFunction` on the two backends via the CDK grant helper
// (proper construct ref, resource-scoped). Async `Event` invocation
// still uses the `lambda:InvokeFunction` action under the hood.
whisperFn.grantInvoke(transcribeDispatchFn);
transcribeAwsFn.grantInvoke(transcribeDispatchFn);

// The dispatcher consumes the transcribe queue (batchSize 1).
transcribeDispatchFn.addEventSource(
  new SqsEventSource(pipelineQueues.transcribe.main, { batchSize: 1 }),
);

// Reserved-concurrency cap (#68): the dispatcher only fires a fast async
// invoke, so a modest cap bounds fan-out without starving throughput.
(transcribeDispatchFn.node.defaultChild as CfnFunction).reservedConcurrentExecutions =
  getConcurrencyCap('TRANSCRIBE_DISPATCH');

// ---------------------------------------------------------------------------
// AWS WAF + admin-managed country / IP CIDR blocking (#198/#199/#200/#201/#202)
// ---------------------------------------------------------------------------
//
// Static WAF resources (Web ACL, four IPSets, CloudWatch log group) live in
// their own `WafStack`. The `wafSync` Lambda reconciles the admin-managed
// `BannedCountry` / `BannedIp` rows onto those resources, woken by the two ban
// tables' DynamoDB streams.
//
// Circular-dependency avoidance: `wafSync` is declared with
// `resourceGroupName:'data'` (see its resource.ts), so its Lambda lives INSIDE
// the data stack — the same fix as `linguisticConfigStream` / `costSnapshotWorker`
// (#317). Consequences that keep the graph acyclic:
//   - The ban tables + their streams are in the data stack, so the
//     EventSourceMappings + Scan/stream IAM created below (in `Stack.of(
//     wafSyncLambda)` === the data stack) are INTRA-stack — no cross-stack edge.
//   - `wafSync` reads via the RAW DynamoDB SDK (Scan), never the Amplify Data
//     client, so there is no `allow.resource` data→function edge either.
//   - The ONLY cross-stack edge is data → WafStack (WAF ARNs/Ids for IAM + env).
//     `WafStack` references nothing, so it's a one-directional leaf — no cycle.
// Putting the Lambda in the shared generic `function` stack instead closes a
// [TranscribeAwsStack, data, function] cycle (synth passes, deploy fails).
const wafStack = backend.createStack('WafStack');
const waf = attachWaf(wafStack);

// Associate the Web ACL with the Amplify Hosting app (#681). Amplify natively
// integrates a CLOUDFRONT-scope WAFv2 Web ACL via a `CfnWebACLAssociation`
// keyed on the APP arn (the AWS "WAF for Amplify via CDK" pattern) — applied by
// `ampx pipeline-deploy`, so there is no manual console step.
//
// Guarded on `AWS_APP_ID` (present only in a real Amplify pipeline build): in
// `ampx sandbox` the id is unset, so the association is skipped — a sandbox
// deploy must never associate (and thus hijack) the prod app's Web ACL. Region
// + account come from the stack tokens; only the app id rides via env (no
// hardcoded ARN). The Web ACL is referenced from the same stack — no new
// cross-stack edge, no CFN cycle.
const amplifyAppId = process.env.AWS_APP_ID;
if (amplifyAppId) {
  new CfnWebACLAssociation(wafStack, 'AmplifyWebAclAssociation', {
    resourceArn: `arn:aws:amplify:${wafStack.region}:${wafStack.account}:apps/${amplifyAppId}`,
    webAclArn: waf.webAcl.attrArn,
  });
}

// REGIONAL WAF read-block on the AppSync data API (#687). The CLOUDFRONT Web
// ACL above protects the website edge only; AppSync is a separate regional
// endpoint, so a read-block needs its own regional Web ACL. wafSync reconciles
// its read IPSets + geo-read rule from the same read_write ban rows.
const appSyncWaf = attachAppSyncWaf(wafStack);
// The association is created in the DATA stack (where the AppSync API lives):
// it imports the regional Web ACL ARN from WafStack (data → WafStack, the same
// one-way direction wafSync already uses) and the API ARN intra-stack — so
// there is NO WafStack → data edge and no CFN cycle.
const graphqlApi = backend.data.resources.cfnResources.cfnGraphqlApi;
new CfnWebACLAssociation(Stack.of(graphqlApi), 'AppSyncWebAclAssociation', {
  resourceArn: graphqlApi.attrArn,
  webAclArn: appSyncWaf.webAcl.attrArn,
});

const wafSyncLambda = backend.wafSync.resources.lambda as LambdaFunction;
// `Stack.of(wafSyncLambda)` resolves to the data stack (resourceGroupName:'data').
const wafSyncStack = Stack.of(wafSyncLambda);

// Web ACL + IPSet identifiers → env (wafSync addresses them via Get*/Update*).
wafSyncLambda.addEnvironment('WEB_ACL_ID', waf.webAcl.attrId);
wafSyncLambda.addEnvironment('WEB_ACL_NAME', WAF_RESOURCE_NAMES.webAcl);
wafSyncLambda.addEnvironment('WEB_ACL_SCOPE', 'CLOUDFRONT');
wafSyncLambda.addEnvironment('IPSET_V4_WRITE_ID', waf.ipSets.v4Write.attrId);
wafSyncLambda.addEnvironment('IPSET_V4_WRITE_NAME', WAF_RESOURCE_NAMES.ipSets.v4Write);
wafSyncLambda.addEnvironment('IPSET_V4_READ_ID', waf.ipSets.v4Read.attrId);
wafSyncLambda.addEnvironment('IPSET_V4_READ_NAME', WAF_RESOURCE_NAMES.ipSets.v4Read);
wafSyncLambda.addEnvironment('IPSET_V6_WRITE_ID', waf.ipSets.v6Write.attrId);
wafSyncLambda.addEnvironment('IPSET_V6_WRITE_NAME', WAF_RESOURCE_NAMES.ipSets.v6Write);
wafSyncLambda.addEnvironment('IPSET_V6_READ_ID', waf.ipSets.v6Read.attrId);
wafSyncLambda.addEnvironment('IPSET_V6_READ_NAME', WAF_RESOURCE_NAMES.ipSets.v6Read);
wafSyncLambda.addEnvironment('GEO_WRITE_RULE_NAME', WAF_RESOURCE_NAMES.geoWriteRule);
wafSyncLambda.addEnvironment('GEO_READ_RULE_NAME', WAF_RESOURCE_NAMES.geoReadRule);
wafSyncLambda.addEnvironment('GEO_WRITE_PRIORITY', String(WAF_RESOURCE_NAMES.geoWritePriority));
wafSyncLambda.addEnvironment('GEO_READ_PRIORITY', String(WAF_RESOURCE_NAMES.geoReadPriority));
wafSyncLambda.addEnvironment('BANNED_BODY_KEY', WAF_RESOURCE_NAMES.bannedBodyKey);
wafSyncLambda.addEnvironment('BLOCKED_REDIRECT_PATH', WAF_RESOURCE_NAMES.blockedRedirectPath);

// AppSync REGIONAL ACL + read IPSets (#687). Presence of APPSYNC_WEB_ACL_ID /
// APPSYNC_IPSET_V4_READ_ID switches on the regional reconcile in wafSync.
wafSyncLambda.addEnvironment('APPSYNC_WEB_ACL_ID', appSyncWaf.webAcl.attrId);
wafSyncLambda.addEnvironment('APPSYNC_WEB_ACL_NAME', APPSYNC_WAF_NAMES.webAcl);
wafSyncLambda.addEnvironment('APPSYNC_IPSET_V4_READ_ID', appSyncWaf.ipSets.v4Read.attrId);
wafSyncLambda.addEnvironment('APPSYNC_IPSET_V4_READ_NAME', APPSYNC_WAF_NAMES.ipSets.v4Read);
wafSyncLambda.addEnvironment('APPSYNC_IPSET_V6_READ_ID', appSyncWaf.ipSets.v6Read.attrId);
wafSyncLambda.addEnvironment('APPSYNC_IPSET_V6_READ_NAME', APPSYNC_WAF_NAMES.ipSets.v6Read);

// wafv2 Get*/Update* on exactly the two ACLs + their IPSets (resource-scoped).
wafSyncLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['wafv2:GetWebACL', 'wafv2:UpdateWebACL', 'wafv2:GetIPSet', 'wafv2:UpdateIPSet'],
    resources: [
      waf.webAcl.attrArn,
      waf.ipSets.v4Write.attrArn,
      waf.ipSets.v4Read.attrArn,
      waf.ipSets.v6Write.attrArn,
      waf.ipSets.v6Read.attrArn,
      appSyncWaf.webAcl.attrArn,
      appSyncWaf.ipSets.v4Read.attrArn,
      appSyncWaf.ipSets.v6Read.attrArn,
    ],
  }),
);

// Ban tables: enable streams + grant Scan + subscribe wafSync. All resources
// created in `wafSyncStack` (=== the data stack, since wafSync is
// resourceGroupName:'data'), so the stream/table references are INTRA-stack —
// no cross-stack edge at all.
const wafSyncDlq = new Queue(wafSyncStack, 'WafSyncStreamDlq', {
  retentionPeriod: Duration.days(14),
});
const banStreamArns: string[] = [];
const banTableArns: string[] = [];
for (const modelName of ['BannedCountry', 'BannedIp'] as const) {
  const table = backend.data.resources.tables[modelName];
  if (!table) {
    throw new Error(`backend: ${modelName} table not found on data resources`);
  }
  const cfnTable = backend.data.resources.cfnResources.amplifyDynamoDbTables[modelName];
  if (!cfnTable) {
    throw new Error(`backend: ${modelName} CFN table wrapper not found on data resources`);
  }
  cfnTable.streamSpecification = { streamViewType: StreamViewType.NEW_AND_OLD_IMAGES };
  const streamArn = table.tableStreamArn;
  if (!streamArn) {
    throw new Error(
      `backend: ${modelName} table stream ARN unavailable after enabling streamSpecification`,
    );
  }
  banStreamArns.push(streamArn);
  banTableArns.push(table.tableArn);

  // Wake-up only — the handler ignores the records and full-reconciles by
  // Scan. A short batching window + reserved concurrency 1 (below) coalesces
  // admin bursts and serialises the optimistic WAF LockToken. onFailure →
  // dedicated DLQ.
  const mapping = new EventSourceMapping(wafSyncStack, `WafSync${modelName}StreamMapping`, {
    target: wafSyncLambda,
    eventSourceArn: streamArn,
    startingPosition: StartingPosition.LATEST,
    batchSize: 100,
    maxBatchingWindow: Duration.seconds(5),
    retryAttempts: 5,
    bisectBatchOnError: true,
    onFailure: new SqsDlq(wafSyncDlq),
  });
  mapping.node.addDependency(wafSyncLambda);
}

// Stream-read + Scan IAM — intra-stack (wafSync + tables both in the data stack).
const wafSyncDataPolicy = new Policy(wafSyncStack, 'WafSyncBanTableReadPolicy', {
  statements: [
    new PolicyStatement({
      actions: [
        'dynamodb:DescribeStream',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:ListStreams',
      ],
      resources: banStreamArns,
    }),
    new PolicyStatement({
      actions: ['dynamodb:Scan'],
      resources: banTableArns,
    }),
  ],
});
wafSyncLambda.role?.attachInlinePolicy(wafSyncDataPolicy);

// Table names → env (raw Scan addresses tables by name).
const bannedCountryTable = backend.data.resources.tables['BannedCountry'];
const bannedIpTable = backend.data.resources.tables['BannedIp'];
wafSyncLambda.addEnvironment('BANNED_COUNTRY_TABLE', bannedCountryTable!.tableName);
wafSyncLambda.addEnvironment('BANNED_IP_TABLE', bannedIpTable!.tableName);

// Serialise reconciles so the WAF LockToken doesn't thrash under bursts.
(wafSyncLambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 1;

// Web ACL ARN surfaced for the operational CloudFront association step
// (Amplify Hosting owns that distribution — see amplify/README.md).
backend.addOutput({
  custom: {
    wafWebAclArn: waf.webAcl.attrArn,
    wafWebAclName: WAF_RESOURCE_NAMES.webAcl,
    // REGIONAL WAF on the AppSync data API (#687) — associated in code.
    appSyncWebAclArn: appSyncWaf.webAcl.attrArn,
    // Viewer-request CF function (#679) — associate with the Amplify-Hosting
    // distribution's default behavior (operational step, see amplify/README.md).
    blockedGeoRewriteFunctionArn: waf.blockedGeoRewrite.attrFunctionArn,
  },
});

// wafMetrics admin query (#673) — reads CloudWatch only (no DDB), so no
// function→data edge; resourceGroupName:'data' keeps it in the data stack.
// `cloudwatch:GetMetricStatistics` has no resource-level scoping, so it must
// be granted on `*` (read-only metric reads). WEB_ACL_NAME is a constant
// string, not a cross-stack token — no new stack edge.
const wafMetricsLambda = backend.wafMetrics.resources.lambda as LambdaFunction;
wafMetricsLambda.addEnvironment('WEB_ACL_NAME', WAF_RESOURCE_NAMES.webAcl);
wafMetricsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['cloudwatch:GetMetricStatistics'],
    resources: ['*'],
  }),
);
