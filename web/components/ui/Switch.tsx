import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './Switch.module.css';

type SwitchProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode;
};

export function Switch({ label, id, className = '', ...rest }: SwitchProps) {
  return (
    <label className={`${styles.wrap} ${className}`} htmlFor={id}>
      <input type="checkbox" id={id} className={styles.input} {...rest} />
      <span className={styles.track} aria-hidden>
        <span className={styles.thumb} />
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
}
