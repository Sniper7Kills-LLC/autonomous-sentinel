import styles from './Footer.module.css';

interface FooterProps {
  buildId?: string;
}

export function Footer({ buildId = 'preview' }: FooterProps) {
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
        <a href="#messages">Messages</a>
        <a href="#skykings">Skykings</a>
        <a href="#skybird">Skybird</a>
        <a href="#map">Propagation map</a>
      </nav>

      <nav className={styles.col} aria-label="Footer resources">
        <div className={styles.heading}>Resources</div>
        <a href="#">REST API</a>
        <a href="#">RSS feed</a>
        <a href="#">GitHub</a>
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
