import { defineBackend } from '@aws-amplify/backend';
import { FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { auth, discordIssuerUrl } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { preprocess } from './functions/preprocess/resource';
import { transcribe } from './functions/transcribe/resource';
import { linguistic } from './functions/linguistic/resource';
import { postConfirmation } from './functions/postConfirmation/resource';
import { discordOidcBridge } from './functions/discordOidcBridge/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  preprocess,
  transcribe,
  linguistic,
  postConfirmation,
  discordOidcBridge,
});

// Discord OIDC bridge needs a public HTTPS endpoint so Cognito can hit
// `/.well-known/openid-configuration`, `/authorize`, `/token`, etc. A Lambda
// function URL (no auth) is the cheapest way to expose it — no API Gateway
// markup, no extra request fee.
const discordBridgeUrl = backend.discordOidcBridge.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  invokeMode: InvokeMode.BUFFERED,
});

// Feed the function URL back in as `OIDC_ISSUER` so the bridge mints id_tokens
// whose `iss` claim matches what Cognito sees. `resources.lambda` is typed as
// the read-only `IFunction` interface; at runtime it is the mutable `Function`
// subclass, so the cast is safe.
(backend.discordOidcBridge.resources.lambda as LambdaFunction).addEnvironment(
  'OIDC_ISSUER',
  discordBridgeUrl.url,
);

// Plug the bridge function URL into the Cognito OIDC IdP we declared in
// `auth/resource.ts`. The `discordIssuerUrl` holder is a `Lazy.string`
// produce-target — CDK resolves it at synth, CFN resolves the underlying
// function-URL token at deploy. No hardcoded URL, single deploy (issue #254).
discordIssuerUrl.url = discordBridgeUrl.url;

// Surface the bridge URL as a stack output so operators / web clients can see
// where the bridge lives without having to crack open the CloudFormation
// console.
backend.addOutput({
  custom: {
    discordOidcBridgeUrl: discordBridgeUrl.url,
  },
});
