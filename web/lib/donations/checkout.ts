import type { TierId } from './tiers';

/**
 * STUBBED Stripe Checkout entry point.
 *
 * Payments are NOT yet enabled. The real Stripe account, secret keys,
 * Price IDs, and server-side session creation are deferred to #206
 * (Stripe account + secrets) and #208. The webhook fulfillment lives in
 * #210. This module exists so the donation/subscription UI shells
 * (#103/#104/#105) are fully built and tested against a clearly-marked
 * placeholder that always returns a "test mode" disabled result —
 * never calling Stripe or loading the Stripe SDK.
 *
 * The site is a static export (no server route handlers), so when
 * payments land the real session-create must run through a Lambda /
 * AppSync mutation invoked from the client, not a Next.js API route.
 */

export interface DonationCheckoutInput {
  /** Net amount the project should receive, in dollars. */
  intendedAmount: number;
  /** Whether the donor opted to cover the Stripe fee. */
  coverFee: boolean;
  /** Whether the donor wants a supporter badge (only honored when signed in). */
  wantsBadge: boolean;
  /** Optional public thank-you message (collected; display deferred post-v1). */
  message?: string;
  /** Cognito sub of the signed-in donor, or null for a guest donation. */
  userId: string | null;
}

export interface SubscriptionCheckoutInput {
  tierId: TierId;
  coverFee: boolean;
  /** Cognito sub — required; subscription requires sign-in (gated at click). */
  userId: string;
}

export interface CheckoutStubResult {
  /** Always false until #206/#208 wire real Stripe. */
  enabled: false;
  status: 'test-mode';
  /** UI-facing explanation. */
  message: string;
}

const TEST_MODE_NOTICE =
  'Payments are not yet enabled (test mode). Stripe Checkout will go live once billing is configured. ' +
  'Your selection was not charged.';

/**
 * Stub for one-time donation Checkout (#103). Returns a disabled
 * test-mode result without contacting Stripe. Replace with a real
 * session-create call (Lambda/AppSync mutation) under #206/#208.
 */
export function createDonationCheckout(_input: DonationCheckoutInput): Promise<CheckoutStubResult> {
  return Promise.resolve({ enabled: false, status: 'test-mode', message: TEST_MODE_NOTICE });
}

/**
 * Stub for recurring subscription Checkout (#104). Returns a disabled
 * test-mode result without contacting Stripe.
 */
export function createSubscriptionCheckout(
  _input: SubscriptionCheckoutInput,
): Promise<CheckoutStubResult> {
  return Promise.resolve({ enabled: false, status: 'test-mode', message: TEST_MODE_NOTICE });
}

/**
 * Stub for the Stripe Customer Portal link (#104). Real implementation
 * mints a signed portal session URL for an existing subscriber under
 * #206/#208. Returns null while disabled so the UI shows a placeholder.
 */
export function getCustomerPortalUrl(_userId: string): Promise<string | null> {
  return Promise.resolve(null);
}
