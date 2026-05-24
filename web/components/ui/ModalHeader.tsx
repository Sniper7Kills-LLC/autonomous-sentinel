import type { ReactNode } from 'react';
import styles from './ModalHeader.module.css';

interface ModalHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  onClose?: () => void;
}

export function ModalHeader({ eyebrow, title, subtitle, onClose }: ModalHeaderProps) {
  return (
    <div className={styles.head}>
      <div className={styles.text}>
        {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h3 className={styles.title}>{title}</h3>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      {onClose && (
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  );
}
