import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './Checkbox.module.css';

type CheckboxProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode;
};

export function Checkbox({ label, id, className = '', ...rest }: CheckboxProps) {
  return (
    <label className={`${styles.wrap} ${className}`} htmlFor={id}>
      <input type="checkbox" id={id} className={styles.input} {...rest} />
      <span className={styles.box} aria-hidden>
        <span className={styles.tick}>✓</span>
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
}

type RadioProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode;
};

export function Radio({ label, id, className = '', ...rest }: RadioProps) {
  return (
    <label className={`${styles.wrap} ${className}`} htmlFor={id}>
      <input type="radio" id={id} className={styles.input} {...rest} />
      <span className={`${styles.box} ${styles.radio}`} aria-hidden>
        <span className={styles.dot} />
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
}
