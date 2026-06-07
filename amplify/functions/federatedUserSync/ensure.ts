/**
 * Idempotent federated-user row ensure (#783).
 *
 * PostConfirmation does not fire for external-IdP (Google / Discord) users, so
 * their `User` + `Reputation` rows are never created by the native-signup path.
 * This module holds the pure, idempotent "ensure the rows exist" logic the
 * federated-sync worker runs (off an SQS hand-off from a sign-in trigger — the
 * cycle-safe pattern, mirroring legacyClaim). All DynamoDB I/O is behind the
 * injectable `FederatedUserStore` port so the decision logic is unit-testable.
 */

export interface FederatedIdentityInput {
  cognitoSub: string;
  email?: string | null;
  /** Display name from the IdP (Google `name` / Discord global name). */
  displayName?: string | null;
  /** Handle from the IdP (Discord username; Google has none). */
  preferredUsername?: string | null;
}

export interface FederatedUserStore {
  /** True when a `User` row already exists for this Cognito sub. */
  userExists: (cognitoSub: string) => Promise<boolean>;
  /**
   * Create the `User` row. MUST be conditional (attribute_not_exists) in the
   * real adapter so a concurrent sign-in race can't duplicate; resolve `false`
   * when the conditional create lost the race (row now exists).
   */
  createUser: (input: FederatedIdentityInput) => Promise<boolean>;
  /** Create the `Reputation` row if absent (idempotent). */
  ensureReputation: (cognitoSub: string) => Promise<void>;
}

export type EnsureOutcome = 'created' | 'exists' | 'skipped';

/**
 * Ensure a federated user's `User` + `Reputation` rows exist. Idempotent:
 * a no-op when the row is already present, safe under the SQS at-least-once
 * redelivery + concurrent sign-ins.
 */
export async function ensureFederatedUser(
  store: FederatedUserStore,
  input: FederatedIdentityInput,
): Promise<EnsureOutcome> {
  if (!input.cognitoSub) return 'skipped';
  if (await store.userExists(input.cognitoSub)) return 'exists';

  const created = await store.createUser(input);
  if (!created) return 'exists'; // lost the conditional-create race
  await store.ensureReputation(input.cognitoSub);
  return 'created';
}
