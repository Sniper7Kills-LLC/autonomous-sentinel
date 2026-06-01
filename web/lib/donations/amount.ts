/**
 * One-time donation amount presets + validation.
 *
 * Presets and the $1 minimum come from #103 / CLAUDE.md → Donations.
 * Custom amounts are free-form but must be ≥ the minimum and a sane
 * dollars-and-cents value.
 */

/** Preset quick-pick amounts, in whole dollars. */
export const DONATION_PRESETS = [5, 10, 25, 50, 100] as const;

/** Minimum accepted donation, in dollars. */
export const MIN_DONATION = 1;

/** Upper sanity bound — Stripe Checkout caps far higher; this just blocks fat-finger entries. */
export const MAX_DONATION = 999_999;

export interface AmountValidation {
  valid: boolean;
  /** Parsed dollar value when valid; `null` otherwise. */
  amount: number | null;
  /** Human-readable reason when invalid. */
  error: string | null;
}

/**
 * Validate a raw amount entry (string from a custom input, or a number
 * from a preset). Accepts up to two decimal places; rejects NaN,
 * negative, sub-minimum, and over-max values.
 */
export function validateAmount(raw: string | number): AmountValidation {
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
  if (trimmed === '') {
    return { valid: false, amount: null, error: 'Enter an amount.' };
  }
  // Dollars with optional cents (max two decimals). Reject anything else.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { valid: false, amount: null, error: 'Enter a dollar amount, e.g. 25 or 25.50.' };
  }
  const amount = Number(trimmed);
  if (!Number.isFinite(amount)) {
    return { valid: false, amount: null, error: 'Enter a valid amount.' };
  }
  if (amount < MIN_DONATION) {
    return { valid: false, amount: null, error: `Minimum donation is $${MIN_DONATION}.` };
  }
  if (amount > MAX_DONATION) {
    return {
      valid: false,
      amount: null,
      error: `Maximum donation is $${MAX_DONATION.toLocaleString()}.`,
    };
  }
  return { valid: true, amount, error: null };
}

/** Format a dollar value for display, always two decimals. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
