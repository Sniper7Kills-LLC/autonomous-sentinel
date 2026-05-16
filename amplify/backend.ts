import { defineBackend } from '@aws-amplify/backend';
import { Fn } from 'aws-cdk-lib';
import {
  type Function as LambdaFunction,
  FunctionUrlAuthType,
  InvokeMode,
} from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { auth, discordIssuerUrl } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { preprocess } from './functions/preprocess/resource';
import { transcribe } from './functions/transcribe/resource';
import { linguistic } from './functions/linguistic/resource';
import { postConfirmation } from './functions/postConfirmation/resource';
import { discordOidcBridge } from './functions/discordOidcBridge/resource';
import { userMutations } from './functions/userMutations/resource';
import { legacyClaimWorker } from './functions/legacyClaimWorker/resource';
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
  legacyClaimWorker,
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

// Cost-discipline budget alarms (#7). Lives in its own nested stack so it can
// be removed or replaced without touching the data / function stacks.
attachBudgetAlarms(backend.createStack('BudgetsStack'), readBudgetConfig());
