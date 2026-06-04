'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getUserLabel, shortSub, type UserLabel } from '@/lib/users/label';
import styles from './UserAttribution.module.css';

interface UserAttributionProps {
  /** Cognito sub to attribute to, or null when there is no user. */
  sub: string | null;
  /** Short prefix label, e.g. "Submitted by" / "Uploaded by". */
  prefix: string;
  /** What to show when `sub` is null (SDR-derived / legacy). */
  nullLabel: string;
}

/**
 * Attribution line resolving a Cognito sub to a public display name and
 * linking to the user's profile (#721).
 *
 * `sub === null` → renders the static `nullLabel` (no link): SDR-derived
 * Messages and legacy Recordings carry no submitter/uploader. Otherwise
 * the name resolves best-effort via `getUserLabel` (degrades to a short
 * sub on failure) and links to `/users/view?id=<sub>` — the same profile
 * route the comments thread uses.
 */
export function UserAttribution({ sub, prefix, nullLabel }: UserAttributionProps) {
  const [resolved, setResolved] = useState<UserLabel | null>(null);

  useEffect(() => {
    if (!sub) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    // Optimistic short-sub label until the name resolves.
    setResolved({ sub, label: shortSub(sub), piiBlanked: false });
    getUserLabel(sub)
      .then((r) => {
        if (!cancelled) setResolved(r);
      })
      .catch(() => {
        /* getUserLabel never rejects; defensive only */
      });
    return () => {
      cancelled = true;
    };
  }, [sub]);

  if (!sub) {
    return (
      <p className={styles.line} data-testid="user-attribution">
        <span className={styles.prefix}>{prefix}</span>
        <span className={styles.nullLabel}>{nullLabel}</span>
      </p>
    );
  }

  return (
    <p className={styles.line} data-testid="user-attribution">
      <span className={styles.prefix}>{prefix}</span>
      <Link className={styles.link} href={`/users/view?id=${encodeURIComponent(sub)}`}>
        {resolved?.label ?? shortSub(sub)}
      </Link>
    </p>
  );
}
