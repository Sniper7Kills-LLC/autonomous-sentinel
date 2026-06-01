'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { useSessionState } from '@/components/account/SessionGreeting';
import { NotificationsForm } from './NotificationsForm';

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§04 · Account"
        title="Notifications"
        lede="Per-channel + per-message-type subscription preferences. Discord webhook URLs are KMS-encrypted at rest."
      />
      <Body />
    </>
  );
}

function Body() {
  const session = useSessionState();
  if (session.loading) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
        Checking your session…
      </p>
    );
  }
  if (!session.signedIn) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
        Sign in to manage your notification preferences. <Link href="/sign-in">Sign in →</Link>
      </p>
    );
  }
  return <NotificationsForm />;
}
