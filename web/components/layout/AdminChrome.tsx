'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AmplifyConfigure } from '@/components/auth/AmplifyConfigure';
import { Footer } from '@/components/ui/Footer';
import { Badge } from '@/components/ui/Badge';
import { SiteHeader } from './SiteHeader';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { isModeratorOrAdmin } from '@/lib/auth/roles';
import styles from './SiteChrome.module.css';

/**
 * Admin / moderator area sections (#71 nav shell). `ready` entries link
 * to live pages; the rest are listed but not yet built — each tracked
 * by the issue noted alongside and filled in by the admin-suite PR
 * group (PR-D). Listing them up front gives the area a stable nav.
 */
const ADMIN_SECTIONS: { href: string; label: string; ready: boolean }[] = [
  { href: '/admin', label: 'Overview', ready: true },
  { href: '/admin/linguistic', label: 'Linguistic Logic', ready: true },
  { href: '/admin/dlq', label: 'DLQ + reprocess', ready: true }, // #107
  { href: '/admin/moderation', label: 'Moderation queue', ready: true }, // #118
  { href: '/admin/bans', label: 'Ban management', ready: true }, // #112
  { href: '/admin/users', label: 'User groups', ready: true }, // #743
  { href: '/admin/audit', label: 'Audit log', ready: true }, // #111
  { href: '/admin/transmitters', label: 'Transmitters', ready: true }, // #108
  { href: '/admin/callsigns', label: 'Callsigns', ready: true }, // #109
  { href: '/admin/banned-regions', label: 'Banned regions', ready: true }, // #113
  { href: '/admin/playback', label: 'Playback limits', ready: true }, // #114
  { href: '/admin/reputation', label: 'Reputation formula', ready: true }, // #117
  { href: '/admin/budget', label: 'AWS budget', ready: true }, // #116
  { href: '/admin/fine-tune', label: 'Fine-tune', ready: false }, // #115
];

/**
 * Chrome for the `(admin)` route group (#71): universal header/footer
 * plus a role-gated sidebar nav. Visible only to `admin` / `moderator`
 * Cognito groups; everyone else is bounced to `/`. The server enforces
 * the same authorization on every admin model — this only gates render.
 */
export function AdminChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { groups, loading } = useCallerGroups();
  const state: 'checking' | 'allowed' | 'denied' = loading
    ? 'checking'
    : isModeratorOrAdmin(groups)
      ? 'allowed'
      : 'denied';

  useEffect(() => {
    if (state === 'denied') router.replace('/?denied=admin');
  }, [state, router]);

  const isActive = (href: string) =>
    href === '/admin'
      ? pathname === '/admin'
      : pathname === href || (pathname?.startsWith(`${href}/`) ?? false);

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div
        className={`${styles.banner} ${styles.bannerRestricted}`}
        role="note"
        aria-label="Classification banner"
      >
        <div className={styles.bannerChip}>
          <span className={styles.bannerTop}>RESTRICTED//ADMIN CONSOLE</span>
          <span className={styles.bannerSub}>OSINT · EAM Archive · Authorized Personnel</span>
        </div>
      </div>
      <AmplifyConfigure />
      <SiteHeader />
      {state !== 'allowed' ? (
        <p className={styles.gateNotice} role={state === 'denied' ? 'alert' : 'status'}>
          {state === 'denied' ? 'Admin access required — redirecting…' : 'Checking your access…'}
        </p>
      ) : (
        <div className={styles.adminBody}>
          <nav className={styles.adminSidebar} aria-label="Admin sections">
            <p className={styles.adminSidebarHeading}>Console</p>
            {ADMIN_SECTIONS.map((s) =>
              s.ready ? (
                <Link
                  key={s.href}
                  href={s.href}
                  aria-current={isActive(s.href) ? 'page' : undefined}
                  className={`${styles.adminNavLink} ${
                    isActive(s.href) ? styles.adminNavLinkActive : ''
                  }`}
                >
                  {s.label}
                </Link>
              ) : (
                <span key={s.href} className={styles.adminNavLink} aria-disabled>
                  {s.label} <Badge tone="neutral">soon</Badge>
                </span>
              ),
            )}
          </nav>
          <main id="main-content" className={styles.adminMain}>
            {children}
          </main>
        </div>
      )}
      <Footer />
    </div>
  );
}
