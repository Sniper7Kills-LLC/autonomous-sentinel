'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth/AuthProvider';
import { useTheme, type Theme } from '@/components/theme/ThemeProvider';
import styles from './UserMenu.module.css';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

function monogram(username: string | null): string {
  const first = username?.trim()?.[0];
  return first ? first.toUpperCase() : '?';
}

/**
 * Signed-in user menu rendered in the top-right of the site header (#736).
 *
 * Renders nothing when signed out — the header keeps a standalone
 * ThemeToggle for guests. For signed-in users the theme picker lives
 * inside this dropdown alongside the account links and sign-out.
 *
 * The dropdown opens on click, closes on outside-click and Escape, and
 * exposes proper `menu` / `menuitem` semantics for assistive tech.
 */
export function UserMenu() {
  const { signedIn, username, sub } = useAuth();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Outside-click closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const onButtonKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }, []);

  const onMenuKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }, []);

  const onSignOut = useCallback(async () => {
    setOpen(false);
    const { signOut } = await import('aws-amplify/auth');
    await signOut();
    window.location.assign('/');
  }, []);

  if (!signedIn) return null;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${username ?? 'your account'}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
      >
        <span className={styles.avatar} aria-hidden>
          {monogram(username)}
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
        >
          {username && (
            <p className={styles.identity} aria-hidden>
              {username}
            </p>
          )}

          <Link
            href={sub ? `/users/view?id=${encodeURIComponent(sub)}` : '/users/view'}
            role="menuitem"
            className={styles.item}
            onClick={close}
          >
            View profile
          </Link>
          <Link href="/settings" role="menuitem" className={styles.item} onClick={close}>
            Settings
          </Link>

          <div className={styles.separator} role="separator" />

          <div className={styles.themeGroup} role="group" aria-label="Theme">
            <span className={styles.themeLabel} aria-hidden>
              Theme
            </span>
            <div className={styles.themeButtons}>
              {THEME_OPTIONS.map((opt) => {
                const isActive = theme === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={`${styles.themeBtn} ${isActive ? styles.themeBtnActive : ''}`}
                    onClick={() => setTheme(opt.value)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.separator} role="separator" />

          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${styles.signOut}`}
            onClick={() => void onSignOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
