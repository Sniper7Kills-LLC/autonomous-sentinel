import { defineBackend } from '@aws-amplify/backend';
import { Fn } from 'aws-cdk-lib';
import { FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
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
