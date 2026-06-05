'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Alert } from '@/components/ui/Alert';
import styles from './SecurityForm.module.css';

const MIN_PASSWORD_LENGTH = 8;

type TotpSetup = {
  /** Raw shared secret to paste into an authenticator app. */
  secret: string;
  /** otpauth:// URI (drives a QR if/when one is added). */
  uri: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `<SecurityForm>` — change-password + TOTP enrollment against Cognito.
 *
 * All `aws-amplify/auth` calls are dynamically imported at the call site
 * so the Amplify auth bundle stays out of the initial page chunk and the
 * module is trivially mockable in tests.
 */
export function SecurityForm() {
  // ── Change password ──────────────────────────────────────────────
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  const changePassword = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setPwError(null);
      setPwSuccess(false);

      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setPwError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (newPassword !== confirmPassword) {
        setPwError('New password and confirmation do not match.');
        return;
      }

      setPwSubmitting(true);
      try {
        const { updatePassword } = await import('aws-amplify/auth');
        await updatePassword({ oldPassword, newPassword });
        setPwSuccess(true);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } catch (err) {
        setPwError(errorMessage(err));
      } finally {
        setPwSubmitting(false);
      }
    },
    [oldPassword, newPassword, confirmPassword],
  );

  // ── Two-factor (TOTP) ────────────────────────────────────────────
  const [mfaLoading, setMfaLoading] = useState(true);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaNotice, setMfaNotice] = useState<string | null>(null);

  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const loadMfaPreference = useCallback(async () => {
    setMfaLoading(true);
    setMfaError(null);
    try {
      const { fetchMFAPreference } = await import('aws-amplify/auth');
      const pref = await fetchMFAPreference();
      setTotpEnabled(pref.enabled?.includes('TOTP') ?? false);
    } catch (err) {
      setMfaError(errorMessage(err));
    } finally {
      setMfaLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMfaPreference();
  }, [loadMfaPreference]);

  const beginEnable = useCallback(async () => {
    setMfaError(null);
    setMfaNotice(null);
    try {
      const { setUpTOTP } = await import('aws-amplify/auth');
      const output = await setUpTOTP();
      const uri = output.getSetupUri('Autonomous Sentinel').toString();
      setSetup({ secret: output.sharedSecret, uri });
      setTotpCode('');
    } catch (err) {
      setMfaError(errorMessage(err));
    }
  }, []);

  const confirmEnable = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setMfaError(null);
      setMfaNotice(null);
      setVerifying(true);
      try {
        const { verifyTOTPSetup, updateMFAPreference } = await import('aws-amplify/auth');
        await verifyTOTPSetup({ code: totpCode });
        await updateMFAPreference({ totp: 'PREFERRED' });
        setTotpEnabled(true);
        setSetup(null);
        setTotpCode('');
        setMfaNotice('Two-factor authentication is now enabled.');
      } catch (err) {
        setMfaError(errorMessage(err));
      } finally {
        setVerifying(false);
      }
    },
    [totpCode],
  );

  const disable = useCallback(async () => {
    setMfaError(null);
    setMfaNotice(null);
    setDisabling(true);
    try {
      const { updateMFAPreference } = await import('aws-amplify/auth');
      await updateMFAPreference({ totp: 'DISABLED' });
      setTotpEnabled(false);
      setMfaNotice('Two-factor authentication has been disabled.');
    } catch (err) {
      setMfaError(errorMessage(err));
    } finally {
      setDisabling(false);
    }
  }, []);

  return (
    <div className={styles.shell}>
      {/* ── Change password ─────────────────────────────────────── */}
      <section className={styles.section} aria-labelledby="sec-password">
        <h2 id="sec-password" className={styles.title}>
          Change password
        </h2>
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            void changePassword(e);
          }}
        >
          <Field label="Current password" htmlFor="current-password" required>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </Field>
          <Field label="New password" htmlFor="new-password" required>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password" required>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>

          {pwError && (
            <Alert tone="danger" title="Could not change password">
              {pwError}
            </Alert>
          )}
          {pwSuccess && (
            <Alert tone="success" title="Password updated">
              Your password has been changed.
            </Alert>
          )}

          <div className={styles.actions}>
            <Button type="submit" loading={pwSubmitting} disabled={pwSubmitting}>
              Update password
            </Button>
          </div>
        </form>
      </section>

      {/* ── Two-factor (TOTP) ───────────────────────────────────── */}
      <section className={styles.section} aria-labelledby="sec-2fa">
        <h2 id="sec-2fa" className={styles.title}>
          Two-factor authentication
        </h2>

        {mfaLoading ? (
          <p className={styles.muted}>Checking your two-factor status…</p>
        ) : (
          <p className={styles.status} aria-live="polite">
            Authenticator app (TOTP): <strong>{totpEnabled ? 'Enabled' : 'Disabled'}</strong>
          </p>
        )}

        {mfaError && (
          <Alert tone="danger" title="Two-factor error">
            {mfaError}
          </Alert>
        )}
        {mfaNotice && (
          <Alert tone="success" title="Two-factor authentication">
            {mfaNotice}
          </Alert>
        )}

        {!mfaLoading && totpEnabled && (
          <div className={styles.actions}>
            <Button
              type="button"
              variant="danger"
              loading={disabling}
              disabled={disabling}
              onClick={() => void disable()}
            >
              Disable two-factor
            </Button>
          </div>
        )}

        {!mfaLoading && !totpEnabled && !setup && (
          <div className={styles.actions}>
            <Button type="button" onClick={() => void beginEnable()}>
              Enable two-factor
            </Button>
          </div>
        )}

        {!mfaLoading && !totpEnabled && setup && (
          <div className={styles.enroll}>
            <p className={styles.muted}>
              Add this secret to your authenticator app (Google Authenticator, 1Password, Authy,
              etc.), then enter the 6-digit code it shows to confirm.
            </p>
            <code className={styles.secret} aria-label="TOTP shared secret">
              {setup.secret}
            </code>
            <form
              className={styles.form}
              noValidate
              onSubmit={(e) => {
                void confirmEnable(e);
              }}
            >
              <Field label="6-digit code" htmlFor="totp-code" required>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                />
              </Field>
              <div className={styles.actions}>
                <Button type="submit" loading={verifying} disabled={verifying}>
                  Verify and enable
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSetup(null);
                    setTotpCode('');
                    setMfaError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
