'use client';

import { useCallback, useState, type JSX } from 'react';
import Link from 'next/link';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { UploadFlow } from '@/components/portal/UploadFlow';
import { RawLog, type LogEntry } from '@/components/portal/RawLog';
import { useAuth } from '@/components/auth/AuthProvider';
import styles from './page.module.css';

export default function HomePage() {
  return (
    <>
      <Hero />
      <PortalPanel />
      <FooterLinks />
    </>
  );
}

function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroEyebrow}>
          <Badge tone="accent">PRE-LAUNCH</Badge>
          <span className={styles.heroRef}>v4.0 · pipeline-test</span>
        </div>
        <h1 className={styles.heroTitle}>Drop an audio capture. Watch it survive the pipeline.</h1>
        <p className={styles.heroLede}>
          The catalogue is still being built; this page is the temporary index where we wire up and
          validate the ingest, transcription, and parsing pipeline end-to-end. Sign in, drop a short
          recording, and watch every stage surface in real time. The same flow that powers SDR
          uploads runs your file.
        </p>
        <div className={styles.heroLinks}>
          <Link className={styles.heroLink} href="/about">
            What this site is →
          </Link>
          <Link className={styles.heroLink} href="/dev/style-guide">
            Design system →
          </Link>
        </div>
      </div>
    </section>
  );
}

function PortalPanel() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const onLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev, entry]);
  }, []);
  const { loading, signedIn, username } = useAuth();

  // Sign-out via the lazily-imported SDK so the fast path never pulls
  // `aws-amplify/auth` into the initial portal chunk.
  const handleSignOut = useCallback(async () => {
    const { signOut } = await import('aws-amplify/auth');
    await signOut();
  }, []);

  // The authenticated upload UI, shared between the context fast-path
  // (already-signed-in callers) and the Authenticator guest path.
  const uploadUi = (signOut: () => void, displayName: string | null): JSX.Element => (
    <div className={styles.authShell}>
      <div className={styles.userBar}>
        <span className={styles.userTag}>
          Signed in as <code>{displayName}</code>
        </span>
        <Button variant="ghost" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
      <UploadFlow onLog={onLog} />
      <RawLog entries={log} />
      <Alert tone="info" title="Heads-up">
        The pipeline is itself in flight. If a stage hangs or fails, the raw log above tells you
        which Lambda or AppSync call was last to respond — please paste it into a GitHub issue with
        the recording id rather than reporting the symptom.
      </Alert>
    </div>
  );

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.eyebrow}>§01 · Audio test</span>
        <h2 className={styles.panelTitle}>Pipeline smoke test</h2>
        <p className={styles.panelLede}>
          Authentication is required because the
          <code> submitRecording </code>
          mutation rejects anonymous callers. Once signed in, drop a file and the portal computes
          its SHA-256, uploads to S3, calls the mutation, and subscribes to the resulting Recording
          for live status updates.
        </p>
      </div>
      {loading ? (
        // Identity is resolved once at the root (#726); while that first
        // resolution is in flight show a status line rather than mounting
        // the Authenticator, so already-signed-in callers never see its
        // re-check flash on navigation.
        <p className={styles.userTag} role="status">
          Checking your session…
        </p>
      ) : signedIn ? (
        uploadUi(() => void handleSignOut(), username)
      ) : (
        <Authenticator>
          {({ signOut, user }) =>
            uploadUi(signOut ?? (() => {}), user?.signInDetails?.loginId ?? user?.username ?? null)
          }
        </Authenticator>
      )}
    </section>
  );
}

function FooterLinks() {
  return (
    <section className={styles.footerLinks}>
      <p>
        Not the audio path? Recording-less Message submissions live on their own route — currently
        in development (#417).
      </p>
    </section>
  );
}
