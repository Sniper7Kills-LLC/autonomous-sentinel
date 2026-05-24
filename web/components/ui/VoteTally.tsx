import styles from './VoteTally.module.css';

interface VoteOption {
  label: string;
  count: number;
}

interface VoteTallyProps {
  field: string;
  options: VoteOption[];
}

export function VoteTally({ field, options }: VoteTallyProps) {
  const total = options.reduce((acc, o) => acc + o.count, 0);
  const leaderLabel = options.reduce<{ label: string; count: number }>(
    (max, o) => (o.count > max.count ? o : max),
    { label: '', count: -1 },
  ).label;
  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.field}>{field}</span>
        <span className={styles.total} aria-label={`${total} total votes`}>
          {total} votes
        </span>
      </div>
      <ul className={styles.list}>
        {options.map((o) => {
          const pct = total === 0 ? 0 : Math.round((o.count / total) * 100);
          const isLeader = o.label === leaderLabel && o.count > 0;
          return (
            <li key={o.label} className={styles.row}>
              <span className={`${styles.label} ${isLeader ? styles.leader : ''}`}>{o.label}</span>
              <span className={styles.barWrap}>
                <span
                  className={`${styles.bar} ${isLeader ? styles.barLeader : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className={styles.count}>{o.count}</span>
              <span className={styles.pct}>{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
