'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { MessagesList } from '@/components/browse/MessagesList';
import { useSessionState } from '@/components/account/SessionGreeting';
import styles from './page.module.css';

export default function LandingPage() {
  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroEyebrow}>
          <span>v4.0 · PRE-LAUNCH</span>
          <span>·</span>
          <span>EAM ARCHIVE</span>
        </div>
        <h1 className={styles.heroTitle}>Catalogue the Emergency Action Message channel.</h1>
        <p className={styles.heroLede}>
          Autonomous Sentinel collects, transcribes, and parses shortwave EAM broadcasts from a
          community of SDR operators. The archive is free to browse. Members can submit
          recording-less witness accounts, upload audio captures, and (post-launch) tune
          notification preferences.
        </p>
        <div className={styles.heroCtas}>
          <Link href="/messages" className={`${styles.heroCta} ${styles.heroCtaPrimary}`}>
            Browse the archive →
          </Link>
          <Link href="/skykings" className={styles.heroCta}>
            Skykings →
          </Link>
          <Link href="/stats" className={styles.heroCta}>
            Stats &amp; charts →
          </Link>
          <Link href="/about" className={styles.heroCta}>
            What this site is →
          </Link>
        </div>
      </section>

      <Suspense fallback={null}>
        <SessionAwareLanding />
      </Suspense>
    </>
  );
}

function SessionAwareLanding() {
  const session = useSessionState();
  return (
    <section className={styles.feedSection} aria-label="Latest broadcasts">
      {session.loading ? null : session.signedIn ? <SignedInPanel name={session.username} /> : null}
      <div className={styles.feedHead}>
        <h2 className={styles.feedTitle}>Latest broadcasts</h2>
        <span className={styles.feedAside}>
          <Link href="/messages">All messages →</Link>
        </span>
      </div>
      <MessagesList limit={20} hideLoadMore />
    </section>
  );
}

function SignedInPanel({ name }: { name: string | null }) {
  return (
    <aside className={styles.personalGrid} aria-label="Signed-in actions">
      <p className={styles.personalGreeting}>
        Signed in as <code>{name ?? 'member'}</code>. Pick up where you left off.
      </p>
      <div className={styles.personalActions}>
        <Link href="/uploads">My uploads</Link>
        <Link href="/portal">Open testing portal</Link>
        <Link href="/submit">Submit a recording-less message</Link>
        <Link href="/settings/notifications">Notification preferences</Link>
        <Link href="/settings/delete">Delete my account</Link>
        <Link href="/sign-in">Sign out</Link>
      </div>
    </aside>
  );
}
