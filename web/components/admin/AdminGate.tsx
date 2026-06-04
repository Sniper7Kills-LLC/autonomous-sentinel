'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { isAdmin } from '@/lib/auth/roles';
import styles from './AdminLinguistic.module.css';

type GateState = 'checking' | 'allowed' | 'denied';

interface AdminGateProps {
  children: ReactNode;
  /**
   * Optional one-line description of the gated area, shown in the denial
   * notice. Defaults to a generic message so the gate reads correctly on
   * any admin page (the hardcoded "Linguistic Logic" text was wrong
   * everywhere except that one page).
   */
  description?: string;
}

/**
 * Admin-only render gate (#546).
 *
 * Resolves the caller's Cognito groups and renders `children` only for
 * the `admin` group. Moderators and members see a "not authorized"
 * notice; the underlying AppSync models enforce the same authorization
 * server-side, so this only decides what to render. Errors fetching the
 * session are treated as denied.
 *
 * Caller groups come from the root {@link useCallerGroups} context (#726)
 * — identity is resolved once per session, so navigating between admin
 * pages no longer re-probes Cognito and flashes "Checking your access…".
 */
export function AdminGate({ children, description }: AdminGateProps) {
  const { groups, loading } = useCallerGroups();
  const state: GateState = loading ? 'checking' : isAdmin(groups) ? 'allowed' : 'denied';

  if (state === 'checking') {
    return (
      <p className={styles.muted} role="status">
        Checking your access…
      </p>
    );
  }

  if (state === 'denied') {
    return (
      <div className={styles.denied} role="alert" data-testid="admin-denied">
        <p className={styles.deniedTitle}>Admin access required</p>
        <p className={styles.muted}>
          {description ?? 'This area is restricted to administrators.'}
        </p>
        <p className={styles.muted}>
          <Link href="/" className={styles.link}>
            Return to the dashboard →
          </Link>
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
