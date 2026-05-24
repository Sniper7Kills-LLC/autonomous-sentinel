import styles from './Pagination.module.css';

interface PaginationProps {
  page: number;
  totalPages: number;
  onChange?: (page: number) => void;
}

export function Pagination({ page, totalPages, onChange }: PaginationProps) {
  const go = (p: number) => {
    if (p < 1 || p > totalPages) return;
    onChange?.(p);
  };
  const pages = pageWindow(page, totalPages);
  return (
    <nav className={styles.root} aria-label="Pagination">
      <button
        type="button"
        className={styles.btn}
        onClick={() => go(page - 1)}
        disabled={page <= 1}
      >
        ← Prev
      </button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`ellipsis-${i}`} className={styles.ellipsis}>
            …
          </span>
        ) : (
          <button
            type="button"
            key={p}
            onClick={() => go(p)}
            className={`${styles.btn} ${p === page ? styles.current : ''}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        className={styles.btn}
        onClick={() => go(page + 1)}
        disabled={page >= totalPages}
      >
        Next →
      </button>
    </nav>
  );
}

function pageWindow(page: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const arr: (number | '…')[] = [1];
  if (page > 3) arr.push('…');
  for (let p = Math.max(2, page - 1); p <= Math.min(total - 1, page + 1); p++) {
    arr.push(p);
  }
  if (page < total - 2) arr.push('…');
  arr.push(total);
  return arr;
}
