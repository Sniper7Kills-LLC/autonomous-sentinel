'use client';

import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { PageShell } from '@/components/layout/PageShell';
import { MessageSubmitForm } from '@/components/submit/MessageSubmitForm';
import { Alert } from '@/components/ui/Alert';

export default function SubmitPage() {
  return (
    <PageShell
      eyebrow="§05 · Submit"
      title="Recording-less submission"
      lede="Heard a broadcast but did not capture audio? Submit a witness account. Reputation + rate-limit gate the publish-now path; first-time submitters land in the moderator queue."
    >
      <Authenticator socialProviders={[]}>
        {() => (
          <>
            <Alert tone="warn" title="Heads-up">
              Every recording-less submission lands flagged for community review — these entries
              never sit alongside SDR-derived broadcasts unchallenged. A daily per-user cap applies
              (default 5 / member, 20 / moderator).
            </Alert>
            <MessageSubmitForm />
          </>
        )}
      </Authenticator>
    </PageShell>
  );
}
