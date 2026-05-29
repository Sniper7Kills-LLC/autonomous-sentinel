'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { selfDelete } from '@/lib/account/selfDelete';
import styles from './SelfDeleteFlow.module.css';

const CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT';

type FlowStage = 'review' | 'confirm' | 'done';

interface SelfDeleteFlowProps {
  username: string | null;
}

/**
 * `<SelfDeleteFlow>` — two-step account self-delete (#101).
 *
 * Step 1 (`review`): explain exactly what happens.
 * Step 2 (`confirm`): user types `DELETE MY ACCOUNT` + clicks
 * delete. Calls the existing `selfDelete` mutation server-side.
 * Step 3 (`done`): success copy with sign-out link.
 *
 * The mutation only blanks the User row — sign-out + Cognito
 * sign-out happens in the next render. Sign-out via the existing
 * `<Authenticator>` flow on `/sign-in` covers the session
 * destruction; this flow surfaces a "Sign out now" link rather
 * than reaching into Cognito directly.
 */
export function SelfDeleteFlow({ username }: SelfDeleteFlowProps) {
  const [stage, setStage] = useState<FlowStage>('review');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (confirm !== CONFIRMATION_PHRASE) {
      setError(`Type exactly "${CONFIRMATION_PHRASE}" to confirm.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await selfDelete();
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [confirm]);

  if (stage === 'done') {
    return (
      <section className={styles.shell} aria-live="polite">
        <div className={styles.success}>
          Your account has been blanked. Profile fields are now null and an audit entry was
          recorded. Sign out below to destroy this session, then close the tab.
        </div>
        <p className={styles.warningCopy}>
          Past uploads, comments, votes, and corrections stay in the archive but show as submitted
          by a deleted user.
        </p>
        <div className={styles.actions}>
          <Link href="/sign-in" className={styles.warningCopy}>
            Sign out →
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.shell}>
      <div className={styles.warning}>
        <p className={styles.warningHeading}>This blanks your profile permanently.</p>
        <ul className={styles.bullets}>
          <li>Display name → `deleted-user-{'<id>'}`.</li>
          <li>Email + preferred username → null.</li>
          <li>Bio + profile fields → null.</li>
          <li>SDR ownership history retained; owner reads as deleted user.</li>
          <li>Uploads, comments, votes, and corrections preserved with anonymous attribution.</li>
          <li>Audit log retains your real Cognito sub for admin investigation only.</li>
          <li>Ban status (if any) remains effective on email + IP.</li>
        </ul>
      </div>

      {stage === 'review' ? (
        <>
          <p className={styles.warningCopy}>
            Account in scope: <strong>{username ?? '(your account)'}</strong>.
          </p>
          <div className={styles.actions}>
            <Link href="/" className={styles.warningCopy}>
              Cancel
            </Link>
            <Button variant="danger" onClick={() => setStage('confirm')}>
              I understand — continue
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.confirm}>
            <label htmlFor="self-delete-confirm" className={styles.confirmLabel}>
              Type <code>{CONFIRMATION_PHRASE}</code> to confirm
            </label>
            <input
              id="self-delete-confirm"
              type="text"
              className={styles.confirmInput}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStage('review')} disabled={submitting}>
              Back
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void submit();
              }}
              loading={submitting}
              disabled={submitting || confirm !== CONFIRMATION_PHRASE}
            >
              Delete my account
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
