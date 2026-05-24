'use client';

import { useTheme, type Theme } from './ThemeProvider';
import styles from './ThemeToggle.module.css';

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className={styles.root} role="radiogroup" aria-label="Theme">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={theme === opt.value}
          className={`${styles.btn} ${theme === opt.value ? styles.active : ''}`}
          onClick={() => setTheme(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
