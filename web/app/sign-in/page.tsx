'use client';

import { PageShell } from '@/components/layout/PageShell';
import { SignInPanel } from './SignInPanel';

export default function SignInPage() {
  return (
    <PageShell
      eyebrow="§04 · Account"
      title="Sign in"
      lede="Email + password sign-in. Members can submit recording-less Messages, upload audio, and (post-launch) configure notifications. Browse the archive without an account on every other route."
    >
      <SignInPanel />
    </PageShell>
  );
}
