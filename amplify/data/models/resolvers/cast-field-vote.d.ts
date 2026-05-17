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
  /**
   * Result of the upstream pipeline step
   * (`lookup-voter-reputation.js`) — the voter's live Reputation
   * row. Null when the row is missing (pre-#36 lazy-create users).
   * The cast resolver reads `prev.result.computedWeight` (or falls
   * back to 1) to stamp `weightAtVoteTime`.
   */
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

export function request(ctx: CastFieldVoteContext): UpdateItemOperation;
export function response(ctx: CastFieldVoteContext): Record<string, unknown> | undefined;
