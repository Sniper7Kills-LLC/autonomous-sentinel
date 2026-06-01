'use client';

import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { codewordFrequency } from '@/lib/stats/frequency';
import type { DisplayMessage } from '@/lib/messages/types';

interface CodewordFrequencyChartProps {
  messages: Pick<DisplayMessage, 'body'>[];
  /** How many top codewords to chart. */
  topN?: number;
}

export function CodewordFrequencyChart({ messages, topN = 20 }: CodewordFrequencyChartProps) {
  const [query, setQuery] = useState('');
  const all = useMemo(() => codewordFrequency(messages), [messages]);
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return q ? all.filter((row) => row.codeword.includes(q)) : all;
  }, [all, query]);
  const charted = useMemo(() => filtered.slice(0, topN), [filtered, topN]);

  if (all.length === 0) {
    return <EmptyChart label="No codewords in this window yet." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', height: '100%' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label
          htmlFor="codeword-search"
          style={{
            fontFamily: 'var(--font-jb-mono)',
            fontSize: '0.7rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-2)',
          }}
        >
          Filter
        </label>
        <input
          id="codeword-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="codeword…"
          style={{
            fontFamily: 'var(--font-jb-mono)',
            fontSize: '0.78rem',
            padding: '0.15rem 0.5rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-1)',
            background: 'var(--surface-2)',
            color: 'var(--text-1)',
          }}
        />
        <span
          style={{ fontFamily: 'var(--font-jb-mono)', fontSize: '0.72rem', color: 'var(--text-2)' }}
        >
          {filtered.length} distinct · charting top {Math.min(topN, charted.length)}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {charted.length === 0 ? (
          <EmptyChart label="No codewords match that filter." />
        ) : (
          <ResponsiveContainer>
            <BarChart
              data={charted}
              layout="vertical"
              margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <CartesianGrid stroke="var(--border-1)" strokeDasharray="2 4" />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fill: 'var(--text-2)', fontSize: 11 }}
                stroke="var(--border-1)"
              />
              <YAxis
                type="category"
                dataKey="codeword"
                width={110}
                interval={0}
                tick={{ fill: 'var(--text-2)', fontSize: 11 }}
                stroke="var(--border-1)"
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-1)',
                  fontFamily: 'var(--font-jb-mono)',
                  fontSize: 12,
                }}
                labelStyle={{ color: 'var(--text-1)' }}
              />
              <Bar dataKey="count" fill="var(--color-accent)" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontFamily: 'var(--font-jb-mono)',
            fontSize: '0.78rem',
            color: 'var(--text-2)',
          }}
        >
          Show all {filtered.length} codewords
        </summary>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
          <caption style={{ textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-2)' }}>
            Per-codeword occurrence counts across message bodies in the window, ranked.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={cellStyle}>
                Codeword
              </th>
              <th scope="col" style={cellStyle}>
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.codeword}>
                <td style={cellStyle}>{row.codeword}</td>
                <td style={cellStyle}>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.25rem 0.5rem',
  borderBottom: '1px solid var(--border-1)',
  fontFamily: 'var(--font-jb-mono)',
  fontSize: '0.8rem',
  color: 'var(--text-1)',
};

function EmptyChart({ label }: { label: string }) {
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
      {label}
    </div>
  );
}
