'use client';

import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { CharFrequencyBucket } from '@/lib/stats/frequency';

interface CharacterFrequencyChartProps {
  /** Precomputed ALLSTATIONS character-frequency buckets (#780). */
  data: CharFrequencyBucket[];
}

type SortMode = 'freq' | 'alpha';

export function CharacterFrequencyChart({ data: freqData }: CharacterFrequencyChartProps) {
  const [sort, setSort] = useState<SortMode>('freq');
  const data = useMemo(
    () =>
      sort === 'alpha' ? [...freqData].sort((a, b) => a.char.localeCompare(b.char)) : freqData,
    [freqData, sort],
  );

  if (data.length === 0) {
    return <EmptyChart label="No ALLSTATIONS characters yet." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', height: '100%' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <span
          style={{
            fontFamily: 'var(--font-jb-mono)',
            fontSize: '0.7rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-2)',
          }}
        >
          Sort
        </span>
        <SortToggle value="freq" current={sort} onChange={setSort} label="Frequency" />
        <SortToggle value="alpha" current={sort} onChange={setSort} label="A–Z 0–9" />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--border-1)" strokeDasharray="2 4" />
            <XAxis
              dataKey="char"
              interval={0}
              tick={{ fill: 'var(--text-2)', fontSize: 11 }}
              stroke="var(--border-1)"
            />
            <YAxis
              allowDecimals={false}
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
            <Bar dataKey="count" fill="var(--color-info)" />
          </BarChart>
        </ResponsiveContainer>
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
          Show data table
        </summary>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
          <caption style={{ textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-2)' }}>
            Per-character occurrence counts across all published ALLSTATIONS bodies.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={cellStyle}>
                Character
              </th>
              <th scope="col" style={cellStyle}>
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.char}>
                <td style={cellStyle}>{row.char}</td>
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

function SortToggle({
  value,
  current,
  onChange,
  label,
}: {
  value: SortMode;
  current: SortMode;
  onChange: (v: SortMode) => void;
  label: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(value)}
      style={{
        fontFamily: 'var(--font-jb-mono)',
        fontSize: '0.75rem',
        padding: '0.15rem 0.5rem',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-1)',
        background: active ? 'var(--color-info)' : 'transparent',
        color: active ? 'var(--surface-1)' : 'var(--text-2)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

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
