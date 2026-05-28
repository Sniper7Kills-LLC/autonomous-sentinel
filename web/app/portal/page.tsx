'use client';

import { useCallback, useEffect, useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { AmplifyConfigure } from '@/components/auth/AmplifyConfigure';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { UploadFlow } from '@/components/portal/UploadFlow';
import { RawLog, type LogEntry } from '@/components/portal/RawLog';
import styles from './page.module.css';

export default function HomePage() {
  return (
    <div className={styles.shell}>
      <div className={styles.classification}>
        <span className={styles.classText}>
          {'// PUBLIC RELEASE · EAM ARCHIVE · OSINT · UNCLASSIFIED //'}
        </span>
      </div>
      <AmplifyConfigure />
      <Header />
      <main className={styles.main}>
        <Hero />
        <PortalPanel />
        <FooterLinks />
      </main>
    </div>
  );
}

function Header() {
  const [clock, setClock] = useState<string>('');
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(0, 19).replace('T', ' '));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <header className={styles.header}>
      <div className={styles.brandRow}>
        <span className={styles.brandMark} aria-hidden>
          ▣
        </span>
        <span className={styles.brandText}>AUTONOMOUS&nbsp;SENTINEL</span>
        <span className={styles.brandSep} aria-hidden>
          ·
        </span>
        <span className={styles.brandTag}>TESTING PORTAL</span>
      </div>
      <div className={styles.headerRight}>
        <span className={styles.clock} suppressHydrationWarning>
          {clock ? `${clock}Z` : ' '}
        </span>
        <ThemeToggle />
      </div>
    </header>
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
          <a className={styles.heroLink} href="/about">
            What this site is →
          </a>
          <a className={styles.heroLink} href="/dev/style-guide">
            Design system →
          </a>
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
      <Authenticator>
        {({ signOut, user }) => (
          <div className={styles.authShell}>
            <div className={styles.userBar}>
              <span className={styles.userTag}>
                Signed in as <code>{user?.signInDetails?.loginId ?? user?.username}</code>
              </span>
              <Button variant="ghost" size="sm" onClick={signOut}>
                Sign out
              </Button>
            </div>
            <UploadFlow onLog={onLog} />
            <RawLog entries={log} />
            <Alert tone="info" title="Heads-up">
              The pipeline is itself in flight. If a stage hangs or fails, the raw log above tells
              you which Lambda or AppSync call was last to respond — please paste it into a GitHub
              issue with the recording id rather than reporting the symptom.
            </Alert>
          </div>
        )}
      </Authenticator>
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
