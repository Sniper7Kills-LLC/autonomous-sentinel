import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

interface PageHeaderProps {
  /** Top-of-page eyebrow (e.g. "§02 · BROWSE"). */
  eyebrow?: string;
  /** Page title — rendered in monospace caps. */
  title?: string;
  /** Optional lede paragraph below the title. */
  lede?: ReactNode;
}

/**
 * Per-page heading block (eyebrow / title / lede).
 *
 * The surrounding chrome (header, footer, classification stripe, the
 * `<main>` landmark) is supplied by the route-group layout (#71); pages
 * render only this heading block plus their own content.
 */
export function PageHeader({ eyebrow, title, lede }: PageHeaderProps) {
  if (!eyebrow && !title && !lede) return null;
  return (
    <header className={styles.pageHead}>
      {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
      {title && <h1 className={styles.title}>{title}</h1>}
      {lede && <p className={styles.lede}>{lede}</p>}
    </header>
  );
}
