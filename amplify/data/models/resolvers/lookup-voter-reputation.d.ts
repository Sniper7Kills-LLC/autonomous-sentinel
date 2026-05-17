/**
 * Type declarations for `lookup-voter-reputation.js`. The JS file
 * ships as-is to the APPSYNC_JS runtime; this `.d.ts` lets the test
 * file import the request / response functions with proper types.
 */

export interface VoterIdentity {
  sub?: string;
}

export interface LookupVoterReputationContext {
  identity?: VoterIdentity | null;
  result?: { computedWeight?: number } | null;
}

export interface GetItemOperation {
  operation: 'GetItem';
  key: { userId: { S: string } };
  projection?: {
    expression: string;
    expressionNames: Record<string, string>;
  };
}

export function request(ctx: LookupVoterReputationContext): GetItemOperation;
export function response(ctx: LookupVoterReputationContext): { computedWeight?: number } | null;
