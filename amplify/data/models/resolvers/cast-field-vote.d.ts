/**
 * Type declarations for the `castFieldVote` AppSync JS resolver. The
 * implementation lives in `./cast-field-vote.js` (shipped as-is to AppSync
 * — the runtime doesn't transpile, so the source stays JS). These
 * declarations exist so unit tests can call `request` / `response`
 * with full type-checking.
 */

export type FieldVoteField = 'SENDER' | 'RECEIVER' | 'BODY' | 'TYPE';

export interface CastFieldVoteArgs {
  messageId: string;
  field: FieldVoteField;
  value: string;
}

export interface CastFieldVoteIdentity {
  sub: string;
}

export interface CastFieldVoteContext {
  arguments: CastFieldVoteArgs;
  identity: CastFieldVoteIdentity | undefined;
  result?: Record<string, unknown>;
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

export function request(ctx: CastFieldVoteContext): UpdateItemOperation;
export function response(ctx: CastFieldVoteContext): Record<string, unknown> | undefined;
