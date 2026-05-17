/**
 * Type declarations for `cast-revision-vote.js`. The JS file ships
 * as-is to the APPSYNC_JS runtime; this `.d.ts` exists so unit
 * tests can call `request` / `response` with full type-checking.
 */

export type RevisionVoteValue = 'UP' | 'DOWN';

export interface CastRevisionVoteArgs {
  revisionId: string;
  value: RevisionVoteValue;
}

export interface CastRevisionVoteIdentity {
  sub: string;
}

export interface CastRevisionVoteContext {
  arguments: CastRevisionVoteArgs;
  identity: CastRevisionVoteIdentity | undefined;
  result?: Record<string, unknown>;
  prev?: { result?: { computedWeight?: number } | null };
}

export interface AttributeValue {
  S?: string;
  N?: string;
}

export interface UpdateItemOperation {
  operation: 'UpdateItem';
  key: Record<string, AttributeValue>;
  update: {
    expression: string;
    expressionNames: Record<string, string>;
    expressionValues: Record<string, AttributeValue>;
  };
}

export function request(ctx: CastRevisionVoteContext): UpdateItemOperation;
export function response(ctx: CastRevisionVoteContext): Record<string, unknown> | undefined;
