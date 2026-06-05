'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getUserLabel, shortSub, type UserLabel } from '@/lib/users/label';

interface UserNameLinkProps {
  /** Cognito sub of the user to name + link. */
  sub: string;
  /** Optional class for the rendered link. */
  className?: string;
}

/**
 * Resolves a Cognito sub to the user's public display name and links to
 * their profile (#737).
 *
 * Most attribution surfaces used to render a raw sub (or a 12-char slice
 * of it). This shares the cached `getUserLabel` resolution that
 * {@link UserAttribution} uses — shows an optimistic short-sub immediately,
 * then swaps in `displayName` / `preferredUsername` once resolved, and
 * degrades to the short sub on failure. Self-deleted accounts resolve to
 * the deactivated label (PII-safe) via `getUserLabel`.
 */
export function UserNameLink({ sub, className }: UserNameLinkProps) {
  const [resolved, setResolved] = useState<UserLabel | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Optimistic short-sub label until the public name resolves.
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

  return (
    <Link className={className} href={`/users/view?id=${encodeURIComponent(sub)}`}>
      {resolved?.label ?? shortSub(sub)}
    </Link>
  );
}
