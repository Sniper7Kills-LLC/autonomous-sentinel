'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { fetchCallerGroups, isModeratorOrAdmin } from '@/lib/auth/roles';
import styles from './SiteChrome.module.css';

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/messages', label: 'Messages' },
  { href: '/skykings', label: 'Skykings' },
  { href: '/skybird', label: 'Skybird' },
  { href: '/map', label: 'Map' },
  { href: '/stats', label: 'Stats' },
  { href: '/portal', label: 'Portal' },
];

/**
 * Primary site header rendered once by every route-group layout (#71).
 *
 * The Admin link is role-gated: it only appears for callers in the
 * `admin` or `moderator` Cognito groups. The server enforces the same
 * authorization on every admin read/mutation, so this only decides
 * what to render — never what is allowed.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [clock, setClock] = useState<string>('');
  const [showAdmin, setShowAdmin] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const tick = () => setClock(new Date().toISOString().slice(0, 19).replace('T', ' '));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const groups = await fetchCallerGroups();
        if (!cancelled) setShowAdmin(isModeratorOrAdmin(groups));
      } catch {
        if (!cancelled) setShowAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isActive = (href: string) =>
    pathname === href || (pathname?.startsWith(`${href}/`) ?? false);

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  };

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brandLink}>
        <span className={styles.brandMark} aria-hidden>
          ▣
        </span>
        <span className={styles.brandText}>AUTONOMOUS&nbsp;SENTINEL</span>
      </Link>
      <nav className={styles.nav} aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? 'page' : undefined}
            className={`${styles.navLink} ${isActive(item.href) ? styles.navLinkActive : ''}`}
          >
            {item.label}
          </Link>
        ))}
        {showAdmin && (
          <Link
            href="/admin"
            aria-current={isActive('/admin') ? 'page' : undefined}
            className={`${styles.navLink} ${styles.navLinkAdmin} ${
              isActive('/admin') ? styles.navLinkActive : ''
            }`}
          >
            Admin
          </Link>
        )}
      </nav>
      <div className={styles.headerRight}>
        <form
          className={styles.search}
          role="search"
          aria-label="Site search"
          onSubmit={onSearchSubmit}
        >
          <input
            type="search"
            className={styles.searchInput}
            aria-label="Search messages"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <span className={styles.clock} suppressHydrationWarning>
          {clock ? `${clock}Z` : ' '}
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
