'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Alert';
import { useSessionState } from '@/components/account/SessionGreeting';
import { CoverFeeToggle } from '@/components/donations/CoverFeeToggle';
import { DONATION_PRESETS, formatUsd, validateAmount } from '@/lib/donations/amount';
import { chargedAmount } from '@/lib/donations/fees';
import { createDonationCheckout, type CheckoutStubResult } from '@/lib/donations/checkout';
import { useBannedGate } from '@/lib/donations/useBannedGate';
import styles from './DonationForm.module.css';

const MESSAGE_MAX = 280;

/**
 * One-time donation form (#103). Amount picker + custom input, optional
 * supporter-badge checkbox, optional public-message field, and the
 * cover-the-fee toggle (#105). The Donate CTA calls the STUBBED
 * Checkout (`createDonationCheckout`) and surfaces the test-mode notice;
 * no real Stripe call happens until #206/#208.
 */
export function DonationForm() {
  const session = useSessionState();
  const signedIn = session.signedIn;
  const banned = useBannedGate();

  const [preset, setPreset] = useState<number | 'custom'>(10);
  const [custom, setCustom] = useState('');
  const [touchedCustom, setTouchedCustom] = useState(false);
  const [coverFee, setCoverFee] = useState(false);
  const [wantsBadge, setWantsBadge] = useState(true);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutStubResult | null>(null);

  const rawAmount = preset === 'custom' ? custom : preset;
  const validation = useMemo(() => validateAmount(rawAmount), [rawAmount]);
  const amount = validation.amount;
  const showCustomError = preset === 'custom' && touchedCustom && !validation.valid;

  // Badge only attaches to a signed-in account; guests donate without one.
  const badgeEffective = signedIn && wantsBadge;

  const canSubmit = validation.valid && !submitting && !banned.banned;

  async function handleDonate() {
    if (!validation.valid || amount === null) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await createDonationCheckout({
        intendedAmount: amount,
        coverFee,
        wantsBadge: badgeEffective,
        message: message.trim() || undefined,
        userId: session.sub,
      });
      setResult(r);
    } finally {
      setSubmitting(false);
    }
  }

  if (banned.resolved && banned.banned) {
    return (
      <Alert tone="danger" title="Donations are unavailable for your account">
        Your account is restricted from making payments. If you believe this is in error, contact a
        moderator.
      </Alert>
    );
  }

  const chargeTotal = amount !== null ? chargedAmount(amount, coverFee) : null;

  return (
    <div className={styles.form}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Amount</legend>
        <div className={styles.presets} role="group" aria-label="Donation amount">
          {DONATION_PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={preset === value}
              className={`${styles.preset} ${preset === value ? styles.presetActive : ''}`}
              onClick={() => setPreset(value)}
            >
              ${value}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={preset === 'custom'}
            className={`${styles.preset} ${preset === 'custom' ? styles.presetActive : ''}`}
            onClick={() => setPreset('custom')}
          >
            Custom
          </button>
        </div>

        {preset === 'custom' && (
          <Field
            label="Custom amount (USD)"
            htmlFor="custom-amount"
            error={showCustomError ? validation.error : undefined}
            hint={!showCustomError ? 'Minimum $1.' : undefined}
          >
            <Input
              id="custom-amount"
              inputMode="decimal"
              placeholder="25.00"
              value={custom}
              invalid={showCustomError}
              onChange={(e) => setCustom(e.currentTarget.value)}
              onBlur={() => setTouchedCustom(true)}
            />
          </Field>
        )}
      </fieldset>

      <Checkbox
        id="supporter-badge"
        checked={wantsBadge}
        disabled={!signedIn}
        onChange={(e) => setWantsBadge(e.currentTarget.checked)}
        label={
          signedIn
            ? 'Grant me a supporter badge (duration scales with the amount).'
            : 'Sign in before donating to earn a supporter badge — guests can still donate.'
        }
      />

      <Field
        label="Public thank-you message (optional)"
        htmlFor="donation-message"
        hint="Collected now; a public thank-you wall is planned for after launch."
      >
        <Textarea
          id="donation-message"
          rows={3}
          maxLength={MESSAGE_MAX}
          placeholder="Keep up the great work!"
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
        />
      </Field>

      <CoverFeeToggle
        intendedAmount={amount ?? 0}
        checked={coverFee}
        onChange={setCoverFee}
        cadenceNoun="donation"
      />

      {result && (
        <Alert tone="warn" title="Payments not yet enabled (test mode)">
          {result.message}
        </Alert>
      )}

      <div className={styles.actions}>
        <Button
          onClick={() => void handleDonate()}
          loading={submitting}
          disabled={!canSubmit}
          size="lg"
        >
          {chargeTotal !== null ? `Donate ${formatUsd(chargeTotal)}` : 'Donate'}
        </Button>
        {!validation.valid && (
          <span className={styles.actionsHint}>{validation.error ?? 'Choose an amount.'}</span>
        )}
      </div>
    </div>
  );
}
