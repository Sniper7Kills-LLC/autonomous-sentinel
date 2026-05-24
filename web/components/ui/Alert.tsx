import type { ReactNode } from 'react';
import styles from './Alert.module.css';

export type AlertTone = 'info' | 'success' | 'warn' | 'danger';

interface AlertProps {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}

const ICON: Record<AlertTone, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  danger: '×',
};

export function Alert({ tone = 'info', title, children, actions }: AlertProps) {
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role="status">
      <span className={styles.icon} aria-hidden>
        {ICON[tone]}
      </span>
      <div className={styles.body}>
        {title && <div className={styles.title}>{title}</div>}
        {children && <div className={styles.message}>{children}</div>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
