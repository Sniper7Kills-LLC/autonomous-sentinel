import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import styles from './Field.module.css';

interface FieldShellProps {
  label?: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, required, children }: FieldShellProps) {
  return (
    <div className={styles.field}>
      {label && (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
          {required && <span className={styles.required}>*</span>}
        </label>
      )}
      {children}
      {hint && !error && <div className={styles.hint}>{hint}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export function Input({ className = '', invalid, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      className={[styles.input, invalid ? styles.invalid : '', className].filter(Boolean).join(' ')}
    />
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export function Textarea({ className = '', invalid, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      className={[styles.input, styles.textarea, invalid ? styles.invalid : '', className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

export function Select({ className = '', invalid, children, ...rest }: SelectProps) {
  return (
    <div className={styles.selectWrap}>
      <select
        {...rest}
        className={[styles.input, styles.select, invalid ? styles.invalid : '', className]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </select>
      <span className={styles.selectChevron} aria-hidden>
        ▾
      </span>
    </div>
  );
}
