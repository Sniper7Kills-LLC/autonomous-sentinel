'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { fetchCallerGroups, isAdmin } from '@/lib/auth/roles';
import styles from './AdminLinguistic.module.css';

type GateState = 'checking' | 'allowed' | 'denied';

interface AdminGateProps {
  children: ReactNode;
}

/**
 * Admin-only render gate (#546).
 *
 * Resolves the caller's Cognito groups and renders `children` only for
 * the `admin` group. Moderators and members see a "not authorized"
 * notice; the underlying AppSync models enforce the same authorization
 * server-side, so this only decides what to render. Errors fetching the
 * session are treated as denied.
 */
export function AdminGate({ children }: AdminGateProps) {
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const groups = await fetchCallerGroups();
        if (!cancelled) setState(isAdmin(groups) ? 'allowed' : 'denied');
      } catch {
        if (!cancelled) setState('denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
          This area manages the Linguistic Logic configuration and is restricted to administrators.
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
