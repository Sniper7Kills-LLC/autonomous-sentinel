/**
 * Type declarations for the `isSuppressed` AppSync JS resolver. See
 * `./suppress-email.d.ts` for the rationale (impl is .js so AppSync can
 * ship it as-is; .d.ts gives tests + callers full type safety).
 */

export interface IsSuppressedArgs {
  email: string;
}

export interface IsSuppressedContext {
  arguments: IsSuppressedArgs;
  result?: unknown;
}

export interface GetItemOperation {
  operation: 'GetItem';
  key: Record<string, { S: string }>;
}

export function request(ctx: IsSuppressedContext): GetItemOperation;
export function response(ctx: IsSuppressedContext): boolean;
