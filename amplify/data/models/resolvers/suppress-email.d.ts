/**
 * Type declarations for the `suppressEmail` AppSync JS resolver. The
 * implementation lives in `./suppress-email.js` (shipped as-is to AppSync
 * — the runtime doesn't transpile, so the source stays JS). These
 * declarations exist so unit tests can call `request` / `response`
 * with full type-checking.
 */

export type SuppressionReason = 'HARD_BOUNCE' | 'SOFT_BOUNCE_REPEATED' | 'COMPLAINT' | 'MANUAL';

export interface SuppressEmailArgs {
  email: string;
  reason: SuppressionReason;
  bounceType?: string;
  notes?: string;
}

export interface SuppressEmailContext {
  arguments: SuppressEmailArgs;
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

export function request(ctx: SuppressEmailContext): UpdateItemOperation;
export function response(ctx: SuppressEmailContext): Record<string, unknown> | undefined;
