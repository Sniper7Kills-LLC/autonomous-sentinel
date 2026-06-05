'use client';

import { useAuth } from '@/components/auth/AuthProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { ProfileEditForm } from '@/components/account/ProfileEditForm';

/**
 * `/settings/profile` — self-service edit page for the signed-in user's
 * public profile (#736).
 *
 * The `(account)` route group already gates this route behind
 * `<RequireAuth>`, so by the time this renders the caller is signed in.
 * We still read `useAuth()` for the `sub` (the `getProfile` key) and the
 * loading flag, surfacing a session-check status while the root
 * `AuthProvider` resolves identity.
 */
export default function EditProfilePage() {
  const { loading, sub } = useAuth();

  return (
    <>
      <PageHeader eyebrow="Settings" title="Edit profile" />
      {loading || !sub ? (
        <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
          Checking your session…
        </p>
      ) : (
        <ProfileEditForm sub={sub} />
      )}
    </>
  );
}
