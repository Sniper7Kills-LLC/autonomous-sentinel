'use client';

import { useState } from 'react';
import styles from './RawLog.module.css';

export type LogEntry = {
  ts: string;
  label: string;
  payload: unknown;
};

interface RawLogProps {
  entries: LogEntry[];
}

export function RawLog({ entries }: RawLogProps) {
  const [open, setOpen] = useState(true);
  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={styles.chev}>{open ? '▾' : '▸'}</span>
        Raw GraphQL / Storage log
        <span className={styles.count}>{entries.length}</span>
      </button>
      {open && (
        <ol className={styles.list}>
          {entries.length === 0 && (
            <li className={styles.empty}>
              No events yet — drop a file and press <kbd>Run pipeline</kbd>.
            </li>
          )}
          {entries.map((e, i) => (
            <li key={i} className={styles.entry}>
              <header className={styles.head}>
                <span className={styles.ts}>{e.ts}</span>
                <span className={styles.label}>{e.label}</span>
              </header>
              <pre className={styles.payload}>{safeStringify(e.payload)}</pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, jsonReplacer, 2);
  } catch (err) {
    return `<<unserializable: ${err instanceof Error ? err.message : 'unknown'}>>`;
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
