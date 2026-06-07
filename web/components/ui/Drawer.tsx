'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { ModalHeader } from './ModalHeader';
import styles from './Drawer.module.css';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: ReactNode;
}

/**
 * Right-side slide-in overlay (~80% viewport) for roomy detail surfaces
 * like the linguistics diagnostics view (#745). Closes on Escape, on a
 * backdrop click, and via the header ✕. Renders nothing when closed, so
 * its `children` (and any lazy fetch they trigger) only mount on open.
 *
 * No portal: under `output: 'export'` there is no document-level portal
 * root at build time, and a fixed-position element escapes layout flow
 * without one. `role="dialog"` + `aria-modal` carry the semantics.
 */
export function Drawer({ open, onClose, title, eyebrow, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the panel so keyboard users land inside the dialog.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onMouseDown={onClose} data-testid="drawer-backdrop">
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // Stop clicks inside the panel from bubbling to the backdrop handler.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ModalHeader eyebrow={eyebrow} title={title} onClose={onClose} />
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
