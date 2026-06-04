'use client';

import type { ReactNode } from 'react';
import { AmplifyConfigure } from '@/components/auth/AmplifyConfigure';
import { Footer } from '@/components/ui/Footer';
import { SiteHeader } from './SiteHeader';
import styles from './SiteChrome.module.css';

/**
 * Universal site chrome rendered once per route-group layout (#71):
 * classification stripe, skip-to-content link (#73), the primary
 * header, the single `<main>` landmark, and the footer. Replaces the
 * per-page `PageShell` so every page inherits identical chrome.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.banner} role="note" aria-label="Classification banner">
        <div className={styles.bannerChip}>
          <span className={styles.bannerTop}>UNCLASSIFIED//FNOUO</span>
          <span className={styles.bannerSub}>OSINT · EAM Archive · Public Release</span>
        </div>
      </div>
      <AmplifyConfigure />
      <SiteHeader />
      <main id="main-content" className={styles.main}>
        {children}
      </main>
      <Footer />
    </div>
  );
}
