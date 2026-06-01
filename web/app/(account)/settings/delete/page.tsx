'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { useSessionState } from '@/components/account/SessionGreeting';
import { SelfDeleteFlow } from './SelfDeleteFlow';

export default function SelfDeletePage() {
  return (
    <>
      <PageHeader
        eyebrow="§04 · Account"
        title="Delete account"
        lede="Permanently blank your profile. Past contributions stay in the archive but become anonymous."
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
        Sign in to delete your account. <Link href="/sign-in">Sign in →</Link>
      </p>
    );
  }
  return <SelfDeleteFlow username={session.username} />;
}
