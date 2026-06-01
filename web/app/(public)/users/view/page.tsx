'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { ProfileView } from '@/components/users/ProfileView';

/**
 * Public user profile surface at `/users/view?id=<cognitoSub>` (#85).
 *
 * The site ships as a static export (`output: 'export'` — see
 * next.config.mjs), which cannot serve a runtime-dynamic `[handle]`
 * segment without build-time `generateStaticParams`, and the user set is
 * live/unbounded. So the profile id rides as a query param on a single
 * static page that fetches client-side — same pattern as
 * `/messages/view`. Migrate to a clean `/users/[handle]` once the app
 * moves to SSR hosting (#330).
 */
export default function UserProfileRoute() {
  return (
    <>
      <PageHeader eyebrow="§07 · Operator" title="Profile" />
      <Suspense fallback={null}>
        <ProfileBody />
      </Suspense>
    </>
  );
}

function ProfileBody() {
  const params = useSearchParams();
  const id = params.get('id');
  if (!id) {
    return (
      <p style={{ color: 'var(--color-fg-faint)', fontFamily: 'var(--font-jb-mono)' }}>
        No user id supplied. Append <code>?id=&lt;cognito-sub&gt;</code> to the URL.
      </p>
    );
  }
  return <ProfileView id={id} />;
}
