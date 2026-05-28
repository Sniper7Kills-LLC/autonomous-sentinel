import type { ReactNode } from 'react';
import styles from './ChartShell.module.css';

interface ChartShellProps {
  eyebrow?: string;
  title: string;
  note?: ReactNode;
  small?: boolean;
  children: ReactNode;
}

export function ChartShell({ eyebrow, title, note, small, children }: ChartShellProps) {
  return (
    <section className={styles.card}>
      <header className={styles.head}>
        {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
        <h3 className={styles.title}>{title}</h3>
      </header>
      <div className={`${styles.chartArea} ${small ? styles.chartAreaSmall : ''}`}>{children}</div>
      {note && <p className={styles.note}>{note}</p>}
    </section>
  );
}
