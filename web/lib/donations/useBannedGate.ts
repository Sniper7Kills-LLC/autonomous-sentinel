'use client';

/**
 * Client-side banned-user gate for the payment surfaces (#103/#104/#105).
 *
 * IMPORTANT: this is a UI affordance only. Authoritative ban enforcement
 * at real Checkout is server-side and tracked in #212 (the Lambda /
 * AppSync mutation that mints the Stripe session must 403 a banned
 * caller regardless of what the client renders). The banned state is
 * NOT currently exposed on the lightweight session probe
 * (`useSessionState`), and we deliberately do not fabricate it here.
 *
 * Until #212 lands a `User.bannedAt` read on the client, this hook
 * returns `banned: false` for everyone and `resolved: true`. When the
 * banned-state read is available, wire it in here (single integration
 * point) and the CTA gate in the pages will start blocking
 * automatically.
 */

export interface BannedGateState {
  /** Whether the current caller is banned from payments. */
  banned: boolean;
  /** Whether the ban state has been determined (vs. still loading). */
  resolved: boolean;
}

export function useBannedGate(): BannedGateState {
  // #212: replace with a real `User.bannedAt` lookup keyed on the caller's
  // Cognito sub once banned-state is readable client-side. Server-side
  // enforcement at Checkout is the source of truth regardless.
  return { banned: false, resolved: true };
}
