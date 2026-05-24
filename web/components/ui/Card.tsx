import type { ReactNode } from 'react';
import styles from './Card.module.css';

interface CardProps {
  /** Optional message-type stripe color along top edge */
  stripe?: string;
  className?: string;
  children: ReactNode;
}

export function Card({ stripe, className = '', children }: CardProps) {
  const style = stripe
    ? ({ ['--card-stripe' as string]: stripe } as React.CSSProperties)
    : undefined;
  return (
    <div
      className={[styles.card, stripe ? styles.striped : '', className].filter(Boolean).join(' ')}
      style={style}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children }: { children: ReactNode }) {
  return <div className={styles.header}>{children}</div>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className={styles.title}>{children}</h3>;
}

export function CardSubtitle({ children }: { children: ReactNode }) {
  return <div className={styles.subtitle}>{children}</div>;
}

export function CardBody({ children }: { children: ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}
