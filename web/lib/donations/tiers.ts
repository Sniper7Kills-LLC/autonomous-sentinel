import { coveredAmount } from './fees';

/**
 * Recurring monthly subscription tiers (#104).
 *
 * Prices + feature bullets mirror CLAUDE.md → Donations / Paid Tier
 * (Recurring monthly subscription). "Initial tier shape, tweakable
 * later." Each tier carries a base monthly price and a derived "covered"
 * price for the cover-the-fee path (#105) — in real Stripe these map to
 * two Price IDs per tier; here the covered price is computed so the UI
 * can render it before the Stripe Prices exist (#206/#208).
 */

export type TierId = 'tier1' | 'tier2' | 'tier3';

export interface SubscriptionTier {
  id: TierId;
  /** Display name, e.g. "Tier 1". */
  name: string;
  /** Base monthly price in dollars. */
  priceMonthly: number;
  /** Short positioning line. */
  tagline: string;
  /** Feature bullets, ordered. Later tiers include "everything in <prev>". */
  features: string[];
  /** Whether to flag this card as the recommended pick. */
  highlight?: boolean;
}

export const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = [
  {
    id: 'tier1',
    name: 'Tier 1',
    priceMonthly: 3,
    tagline: 'Support the archive, get the badge.',
    features: ['Supporter badge', 'Historical access to 180 days'],
  },
  {
    id: 'tier2',
    name: 'Tier 2',
    priceMonthly: 7,
    tagline: 'For researchers who pull data.',
    highlight: true,
    features: ['Everything in Tier 1', 'Bulk recording download (capped)', 'Advanced filters'],
  },
  {
    id: 'tier3',
    name: 'Tier 3',
    priceMonthly: 15,
    tagline: 'Full access + integrations.',
    features: [
      'Everything in Tier 2',
      'Discord webhook relays',
      'REST API rate-limit bump',
      'Full historical access',
    ],
  },
] as const;

/** The distinct feature rows used to build the comparison matrix (#104). */
export interface ComparisonRow {
  label: string;
  /** Which tiers include this feature. */
  tiers: Record<TierId, boolean>;
}

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    label: 'Supporter badge',
    tiers: { tier1: true, tier2: true, tier3: true },
  },
  {
    label: 'Historical access',
    // 180 days at T1/T2 (T2 inherits T1); full history at T3.
    tiers: { tier1: true, tier2: true, tier3: true },
  },
  {
    label: 'Bulk recording download (capped)',
    tiers: { tier1: false, tier2: true, tier3: true },
  },
  {
    label: 'Advanced filters',
    tiers: { tier1: false, tier2: true, tier3: true },
  },
  {
    label: 'Discord webhook relays',
    tiers: { tier1: false, tier2: false, tier3: true },
  },
  {
    label: 'REST API rate-limit bump',
    tiers: { tier1: false, tier2: false, tier3: true },
  },
  {
    label: 'Full historical access',
    tiers: { tier1: false, tier2: false, tier3: true },
  },
] as const;

/** Look up a tier by id. */
export function getTier(id: TierId): SubscriptionTier | undefined {
  return SUBSCRIPTION_TIERS.find((t) => t.id === id);
}

/** Monthly price the subscriber pays for a tier given the cover-fee toggle. */
export function tierMonthlyCharge(tier: SubscriptionTier, coverFee: boolean): number {
  return coverFee ? coveredAmount(tier.priceMonthly) : tier.priceMonthly;
}
