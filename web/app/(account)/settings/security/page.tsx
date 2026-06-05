'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/components/auth/AuthProvider';
import { SecurityForm } from './SecurityForm';

/**
 * `/settings/security` — self-service account security controls (#736).
 *
 * Two surfaces, both driven entirely client-side against Cognito via
 * `aws-amplify/auth` (the route group is already gated by `RequireAuth`
 * in `(account)/layout.tsx`):
 *   - Change password (`updatePassword`)
 *   - Two-factor authentication / TOTP enrollment
 *     (`setUpTOTP` → `verifyTOTP` → `updateMFAPreference`,
 *      state read via `fetchMFAPreference`)
 *
 * Web is a static export (`output: 'export'`); this page is client-only
 * with no server actions or dynamic segments.
 */
export default function SecurityPage() {
  const { loading } = useAuth();

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Security"
        lede="Change your password and manage two-factor authentication for this account."
      />
      {loading ? (
        <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
          Checking your session…
        </p>
      ) : (
        <SecurityForm />
      )}
    </>
  );
}
