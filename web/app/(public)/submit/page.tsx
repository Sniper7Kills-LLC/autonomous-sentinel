'use client';

import { type ReactNode } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { PageHeader } from '@/components/layout/PageHeader';
import { MessageSubmitForm } from '@/components/submit/MessageSubmitForm';
import { Alert } from '@/components/ui/Alert';
import { useAuth } from '@/components/auth/AuthProvider';

/** The signed-in submission body — flag notice + the form. */
function SubmitBody(): ReactNode {
  return (
    <>
      <Alert tone="warn" title="Heads-up">
        Every recording-less submission lands flagged for community review — these entries never sit
        alongside SDR-derived broadcasts unchallenged. A daily per-user cap applies (default 5 /
        member, 20 / moderator).
      </Alert>
      <MessageSubmitForm />
    </>
  );
}

export default function SubmitPage() {
  // Identity is resolved once at the root (#728). Signed-in callers render
  // the form directly; only guests mount the Authenticator. This avoids the
  // Authenticator re-evaluating the session (and flashing its sign-in
  // chrome) on every navigation to this page.
  const { loading, signedIn } = useAuth();

  return (
    <>
      <PageHeader
        eyebrow="§05 · Submit"
        title="Recording-less submission"
        lede="Heard a broadcast but did not capture audio? Submit a witness account. Reputation + rate-limit gate the publish-now path; first-time submitters land in the moderator queue."
      />
      {loading ? (
        <p role="status">Checking your session…</p>
      ) : signedIn ? (
        <SubmitBody />
      ) : (
        <Authenticator socialProviders={[]}>{() => <SubmitBody />}</Authenticator>
      )}
    </>
  );
}
