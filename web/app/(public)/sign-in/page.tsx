'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { SignInPanel } from './SignInPanel';

export default function SignInPage() {
  return (
    <>
      <PageHeader
        eyebrow="§04 · Account"
        title="Sign in"
        lede="Email + password sign-in. Members can submit recording-less Messages, upload audio, and (post-launch) configure notifications. Browse the archive without an account on every other route."
      />
      <SignInPanel />
    </>
  );
}
