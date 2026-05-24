import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'success' | 'warn' | 'danger';

export type MessageType =
  | 'SKYKING'
  | 'SKYBIRD'
  | 'SKYMASTER'
  | 'ALLSTATIONS'
  | 'RADIOCHECK'
  | 'BACKEND'
  | 'DISREGARDED'
  | 'OTHER';

interface BadgeProps {
  tone?: BadgeTone;
  outline?: boolean;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', outline, children }: BadgeProps) {
  return (
    <span
      className={[styles.badge, styles[tone], outline ? styles.outline : '']
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

interface MessageTypeBadgeProps {
  type: MessageType;
}

export function MessageTypeBadge({ type }: MessageTypeBadgeProps) {
  return (
    <span className={`${styles.badge} ${styles.msgType}`} data-msg-type={type}>
      {type}
    </span>
  );
}
