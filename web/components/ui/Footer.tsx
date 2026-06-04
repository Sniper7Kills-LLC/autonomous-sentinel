import Link from 'next/link';
import styles from './Footer.module.css';

/**
 * Build identifier shown in the footer. Injected at build time by
 * next.config.mjs as `NEXT_PUBLIC_BUILD_SHA` (Amplify's `AWS_COMMIT_ID`,
 * falling back to the local git short SHA, then `dev`). Inlined into the
 * bundle at build, so it reflects the deployed commit.
 */
const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA || 'dev';

interface FooterProps {
  buildId?: string;
}

export function Footer({ buildId = BUILD_SHA }: FooterProps) {
  const year = new Date().getUTCFullYear();
  return (
    <footer className={styles.footer}>
      <div className={styles.col}>
        <div className={styles.brand}>
          <span className={styles.mark}>◤</span>
          <span className={styles.brandText}>AUTONOMOUS SENTINEL</span>
        </div>
        <div className={styles.tagline}>Emergency Action Message broadcast catalog · v4.0</div>
      </div>

      <nav className={styles.col} aria-label="Footer navigation">
        <div className={styles.heading}>Site</div>
        <Link href="/messages">Messages</Link>
        <Link href="/skykings">Skykings</Link>
        <Link href="/skybird">Skybird</Link>
        <Link href="/map">Propagation map</Link>
        <Link href="/donate">Donate</Link>
        <Link href="/support">Supporter tiers</Link>
        <Link href="/transparency">Cost transparency</Link>
      </nav>

      <nav className={styles.col} aria-label="Footer resources">
        <div className={styles.heading}>Resources</div>
        {/* REST API + RSS feed routes are not built yet — placeholders. */}
        <a href="#">REST API</a>
        <a href="#">RSS feed</a>
        <a
          href="https://github.com/Sniper7Kills-LLC/autonomous-sentinel"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </nav>

      <div className={styles.col}>
        <div className={styles.heading}>System</div>
        <div className={styles.meta}>
          <span className={styles.metaKey}>BUILD</span>
          <span className={styles.metaVal}>{buildId}</span>
        </div>
        <div className={styles.meta}>
          <span className={styles.metaKey}>STATUS</span>
          <span className={styles.metaVal}>
            <span className={styles.pulse} aria-hidden /> Operational
          </span>
        </div>
        <div className={styles.copyright}>© {year} Sniper7Kills LLC · Apache 2.0</div>
      </div>
    </footer>
  );
}
