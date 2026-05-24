'use client';

import { useCallback, useRef, type KeyboardEvent } from 'react';
import { useTheme, type Theme } from './ThemeProvider';
import styles from './ThemeToggle.module.css';

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = OPTIONS.findIndex((o) => o.value === theme);

  const moveFocus = useCallback(
    (delta: number) => {
      const next = (selectedIdx + delta + OPTIONS.length) % OPTIONS.length;
      const opt = OPTIONS[next];
      if (!opt) return;
      setTheme(opt.value);
      btnRefs.current[next]?.focus();
    },
    [selectedIdx, setTheme],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(-1);
          break;
        case 'Home':
          e.preventDefault();
          moveFocus(-selectedIdx);
          break;
        case 'End':
          e.preventDefault();
          moveFocus(OPTIONS.length - 1 - selectedIdx);
          break;
        default:
      }
    },
    [moveFocus, selectedIdx],
  );

  return (
    <div className={styles.root} role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown}>
      {OPTIONS.map((opt, i) => {
        const isSelected = theme === opt.value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={`${styles.btn} ${isSelected ? styles.active : ''}`}
            onClick={() => setTheme(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
