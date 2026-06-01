/**
 * Stripe US card-present processing fee math.
 *
 * Current published US rate: 2.9% + $0.30 per successful card charge.
 * When a donor opts to "cover the fee" (#105), they pay a grossed-up
 * amount so that — after Stripe deducts its cut — the project nets the
 * donor's intended amount.
 *
 *   net = covered − (covered * 0.029 + 0.30)
 * solve for `covered` given the target `net = intended`:
 *   covered = (intended + 0.30) / (1 − 0.029)
 *
 * Out of scope (#105): non-US Stripe accounts and per-payment-method
 * fee variation. Cards only at v1.
 */

/** Stripe US percentage component (2.9%). */
export const STRIPE_PERCENT_FEE = 0.029;
/** Stripe US fixed component, in dollars ($0.30). */
export const STRIPE_FIXED_FEE = 0.3;

/** Round a dollar amount up to the next whole cent. */
export function roundUpCents(amount: number): number {
  // Multiply into cents, nudge past binary-float noise, ceil, divide back.
  return Math.ceil(Math.round(amount * 1e6) / 1e4) / 100;
}

/**
 * Grossed-up total the donor pays so the project nets `intended`.
 * Rounded up to the next cent. Returns `intended` unchanged for
 * non-positive inputs (nothing to gross up).
 */
export function coveredAmount(intended: number): number {
  if (!Number.isFinite(intended) || intended <= 0) return 0;
  const gross = (intended + STRIPE_FIXED_FEE) / (1 - STRIPE_PERCENT_FEE);
  return roundUpCents(gross);
}

/**
 * The extra the donor pays on top of `intended` to cover the fee.
 * Always non-negative; rounded to the cent via `coveredAmount`.
 */
export function feeUplift(intended: number): number {
  if (!Number.isFinite(intended) || intended <= 0) return 0;
  return roundUpCents(coveredAmount(intended) - intended);
}

/** What the donor is actually charged given the cover-fee toggle state. */
export function chargedAmount(intended: number, coverFee: boolean): number {
  return coverFee ? coveredAmount(intended) : roundUpCents(Math.max(intended, 0));
}
