'use client';

import type { StreakInfo } from '@/lib/stats/aggregates';

interface StreakListProps {
  /** Precomputed per-type consecutive-day streaks (#780). */
  streaks: StreakInfo[];
}

/** Consecutive-day streaks per message type, derived from precomputed daily
 *  counts. `current` is the run up to the most recent active day. */
export function StreakList({ streaks }: StreakListProps) {
  if (streaks.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-2)',
          fontFamily: 'var(--font-jb-mono)',
          fontSize: '0.85rem',
        }}
      >
        No streak data yet.
      </div>
    );
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <caption style={{ textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-2)' }}>
        Consecutive UTC days each type was broadcast — current run + all-time longest.
      </caption>
      <thead>
        <tr>
          <th scope="col" style={cell}>
            Type
          </th>
          <th scope="col" style={cell}>
            Current
          </th>
          <th scope="col" style={cell}>
            Longest
          </th>
          <th scope="col" style={cell}>
            Last day
          </th>
        </tr>
      </thead>
      <tbody>
        {streaks.map((s) => (
          <tr key={s.type}>
            <td style={cell}>{s.type}</td>
            <td style={cell}>{s.current}</td>
            <td style={cell}>{s.longest}</td>
            <td style={cell}>{s.lastDate ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cell: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.25rem 0.5rem',
  borderBottom: '1px solid var(--border-1)',
  fontFamily: 'var(--font-jb-mono)',
  fontSize: '0.8rem',
  color: 'var(--text-1)',
};
