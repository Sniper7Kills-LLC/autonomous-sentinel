'use client';

import { Switch } from '@/components/ui/Switch';
import { coveredAmount, feeUplift } from '@/lib/donations/fees';
import { formatUsd } from '@/lib/donations/amount';
import styles from './CoverFeeToggle.module.css';

interface CoverFeeToggleProps {
  /** Net amount (dollars) the project should receive before any uplift. */
  intendedAmount: number;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Word for the cadence — "donation" (one-time) or "month" (recurring). */
  cadenceNoun?: string;
  id?: string;
}

/**
 * Reusable "cover the fee" toggle (#105). Computes the Stripe US fee
 * (2.9% + $0.30) on the chosen amount and shows the adjusted total in
 * real time. Fee state is held by the parent (per-donation, not
 * persisted) — this component is purely controlled.
 */
export function CoverFeeToggle({
  intendedAmount,
  checked,
  onChange,
  cadenceNoun = 'donation',
  id = 'cover-fee',
}: CoverFeeToggleProps) {
  const valid = Number.isFinite(intendedAmount) && intendedAmount > 0;
  const uplift = valid ? feeUplift(intendedAmount) : 0;
  const covered = valid ? coveredAmount(intendedAmount) : 0;

  return (
    <div className={styles.wrap}>
      <Switch
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        label={
          valid ? (
            <span>
              I&rsquo;ll cover the Stripe fee &mdash; adds{' '}
              <strong className={styles.amount}>{formatUsd(uplift)}</strong>, so 100% of your{' '}
              <strong className={styles.amount}>{formatUsd(intendedAmount)}</strong> {cadenceNoun}{' '}
              reaches the project.
            </span>
          ) : (
            <span>
              I&rsquo;ll cover the Stripe fee so 100% of my {cadenceNoun} reaches the project.
            </span>
          )
        }
      />
      {valid && checked && (
        <div className={styles.total} aria-live="polite">
          <span className={styles.totalKey}>You&rsquo;ll be charged</span>
          <span className={styles.totalVal}>{formatUsd(covered)}</span>
        </div>
      )}
      <p className={styles.footnote}>
        Fees are Stripe&rsquo;s published US card rate (2.9% + $0.30); international or non-card
        methods may differ slightly.
      </p>
    </div>
  );
}
