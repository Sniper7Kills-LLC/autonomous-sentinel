'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AmplifyConfigure } from '@/components/auth/AmplifyConfigure';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Footer } from '@/components/ui/Footer';
import styles from './PageShell.module.css';

interface PageShellProps {
  /** Top-of-page eyebrow (e.g. "§02 · BROWSE"). */
  eyebrow?: string;
  /** Page title — rendered in monospace caps. */
  title?: string;
  /** Optional lede paragraph below the title. */
  lede?: ReactNode;
  /** Hide the standard page header block (title/lede). Use when the
   *  page provides a fully custom hero. */
  bare?: boolean;
  children: ReactNode;
}

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/messages', label: 'Messages' },
  { href: '/skykings', label: 'Skykings' },
  { href: '/skybird', label: 'Skybird' },
  { href: '/stats', label: 'Stats' },
  { href: '/portal', label: 'Portal' },
];

export function PageShell({ eyebrow, title, lede, bare, children }: PageShellProps) {
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
        {!bare && (title || eyebrow || lede) && (
          <header className={styles.pageHead}>
            {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
            {title && <h1 className={styles.title}>{title}</h1>}
            {lede && <p className={styles.lede}>{lede}</p>}
          </header>
        )}
        {children}
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  const [clock, setClock] = useState<string>('');
  const pathname = usePathname();
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(0, 19).replace('T', ' '));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brandLink}>
        <span className={styles.brandMark} aria-hidden>
          ▣
        </span>
        <span className={styles.brandText}>AUTONOMOUS&nbsp;SENTINEL</span>
      </Link>
      <nav className={styles.nav} aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className={styles.headerRight}>
        <span className={styles.clock} suppressHydrationWarning>
          {clock ? `${clock}Z` : ' '}
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
