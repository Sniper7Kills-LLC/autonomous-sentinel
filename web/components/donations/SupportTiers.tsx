'use client';

import { useState } from 'react';
import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardSubtitle,
  CardTitle,
} from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { Switch } from '@/components/ui/Switch';
import { useSessionState } from '@/components/account/SessionGreeting';
import { useBannedGate } from '@/lib/donations/useBannedGate';
import {
  COMPARISON_ROWS,
  SUBSCRIPTION_TIERS,
  tierMonthlyCharge,
  type SubscriptionTier,
  type TierId,
} from '@/lib/donations/tiers';
import { formatUsd } from '@/lib/donations/amount';
import { createSubscriptionCheckout, type CheckoutStubResult } from '@/lib/donations/checkout';
import styles from './SupportTiers.module.css';

/**
 * Recurring tiers surface (#104). Three pricing cards + a comparison
 * matrix + a per-card Checkout CTA. Subscription requires sign-in
 * (gated at the click). Existing-subscriber "Manage subscription"
 * portal link is a placeholder — subscription state read + Customer
 * Portal session are wired with real Stripe under #206/#208/#210/#211.
 * Banned-user CTA gate is client-side only (server-side: #212).
 */
export function SupportTiers() {
  const session = useSessionState();
  const banned = useBannedGate();
  const [coverFee, setCoverFee] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [pending, setPending] = useState<TierId | null>(null);
  const [result, setResult] = useState<{ tier: TierId; res: CheckoutStubResult } | null>(null);

  // Subscription state (active tier, grace period) comes from the Donation
  // model via webhook fulfillment — #40/#210/#211. Not readable on this
  // static client yet, so every signed-in user sees the subscribe path.
  const activeTier: TierId | null = null;

  async function handleSubscribe(tier: SubscriptionTier) {
    if (!session.signedIn || !session.sub) return; // CTA gates this; guard anyway.
    setPending(tier.id);
    setResult(null);
    try {
      const res = await createSubscriptionCheckout({
        tierId: tier.id,
        coverFee,
        userId: session.sub,
      });
      setResult({ tier: tier.id, res });
    } finally {
      setPending(null);
    }
  }

  const ctaBlocked = banned.resolved && banned.banned;

  return (
    <div className={styles.wrap}>
      {ctaBlocked && (
        <Alert tone="danger" title="Subscriptions are unavailable for your account">
          Your account is restricted from making payments. Contact a moderator if you believe this
          is in error.
        </Alert>
      )}

      <div className={styles.feeRow}>
        <Switch
          id="cover-fee-recurring"
          checked={coverFee}
          onChange={(e) => setCoverFee(e.currentTarget.checked)}
          label="Cover the Stripe fee on my subscription so 100% reaches the project."
        />
      </div>

      <div className={styles.grid}>
        {SUBSCRIPTION_TIERS.map((tier) => {
          const charge = tierMonthlyCharge(tier, coverFee);
          const isActive = activeTier === tier.id;
          const tierResult = result?.tier === tier.id ? result.res : null;
          return (
            <Card key={tier.id} className={tier.highlight ? styles.highlight : undefined}>
              <CardHeader>
                <div className={styles.cardTop}>
                  <CardTitle>{tier.name}</CardTitle>
                  {tier.highlight && <Badge tone="accent">Popular</Badge>}
                </div>
                <CardSubtitle>{tier.tagline}</CardSubtitle>
                <div className={styles.price}>
                  <span className={styles.priceVal}>{formatUsd(charge)}</span>
                  <span className={styles.priceUnit}>/ month</span>
                </div>
              </CardHeader>
              <CardBody>
                <ul className={styles.features}>
                  {tier.features.map((f) => (
                    <li key={f}>
                      <span className={styles.check} aria-hidden>
                        ✓
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
              </CardBody>
              <CardFooter>
                {isActive ? (
                  <ManagePortal />
                ) : !session.signedIn ? (
                  <Button variant="secondary" disabled title="Sign in to subscribe">
                    Sign in to subscribe
                  </Button>
                ) : (
                  <Button
                    variant={tier.highlight ? 'primary' : 'secondary'}
                    loading={pending === tier.id}
                    disabled={ctaBlocked || pending !== null}
                    onClick={() => void handleSubscribe(tier)}
                  >
                    Subscribe to {tier.name}
                  </Button>
                )}
                {tierResult && (
                  <p className={styles.testNotice} role="status">
                    {tierResult.message}
                  </p>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      <button
        type="button"
        className={styles.compareToggle}
        aria-expanded={showCompare}
        onClick={() => setShowCompare((v) => !v)}
      >
        {showCompare ? 'Hide feature comparison' : 'Show feature comparison'}
      </button>

      {showCompare && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                {SUBSCRIPTION_TIERS.map((t) => (
                  <th key={t.id} scope="col">
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {SUBSCRIPTION_TIERS.map((t) => (
                    <td key={t.id} className={styles.cell}>
                      {row.tiers[t.id] ? (
                        <span className={styles.yes} aria-label="Included">
                          ✓
                        </span>
                      ) : (
                        <span className={styles.no} aria-label="Not included">
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Manage-subscription placeholder shown to active subscribers. The real
 * Stripe Customer Portal session URL is minted server-side under
 * #206/#208; until then the link is disabled.
 */
function ManagePortal() {
  return (
    <Button variant="ghost" disabled title="Available once billing is enabled (#206/#208)">
      Manage subscription
    </Button>
  );
}
