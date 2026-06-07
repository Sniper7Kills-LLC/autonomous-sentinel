/**
 * Federated-identity detection for the PostAuthentication trigger (#783).
 *
 * PostAuthentication fires on every sign-in (native + federated). Only
 * federated (external-IdP) sign-ins need the User-row ensure hand-off — native
 * signups already got their row via postConfirmation. Cognito marks federated
 * users with a non-empty `identities` attribute (a JSON array of linked IdPs);
 * native users have none. This pure helper extracts the sync payload from the
 * trigger's `userAttributes`, returning null for native (or sub-less) events.
 */

import type { FederatedIdentityInput } from '../federatedUserSync/ensure';

interface TriggerLike {
  request?: { userAttributes?: Record<string, string | undefined> };
}

/** Whether the `identities` attribute marks this as a federated identity. */
export function isFederated(attrs: Record<string, string | undefined>): boolean {
  const raw = attrs.identities;
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    // A non-JSON but non-empty `identities` still indicates federation.
    return raw.trim().length > 0;
  }
}

/**
 * Extract the federated-sync payload from a PostAuthentication event, or null
 * when the event is a native sign-in / lacks a Cognito sub.
 */
export function extractFederatedIdentity(event: TriggerLike): FederatedIdentityInput | null {
  const attrs = event.request?.userAttributes ?? {};
  if (!isFederated(attrs)) return null;
  const cognitoSub = attrs.sub;
  if (!cognitoSub) return null;
  return {
    cognitoSub,
    email: attrs.email ?? null,
    displayName: attrs.name || null,
    preferredUsername: attrs.preferred_username || null,
  };
}
