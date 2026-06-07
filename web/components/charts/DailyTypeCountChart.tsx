'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { DailyTypeRow } from '@/lib/stats/aggregates';

interface DailyTypeCountChartProps {
  /** Precomputed per-day, per-type series (#780). */
  dates: DailyTypeRow[];
  types: string[];
}

// Stable palette cycled across message types (CSS theme tokens).
const PALETTE = [
  'var(--color-accent)',
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-danger)',
  '#8b5cf6',
  '#14b8a6',
  '#f97316',
];

export function DailyTypeCountChart({ dates, types }: DailyTypeCountChartProps) {
  if (dates.length === 0) {
    return <EmptyChart label="No daily-count data yet." />;
  }
  return (
    <ResponsiveContainer>
      <BarChart data={dates} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="var(--border-1)" strokeDasharray="2 4" />
        <XAxis
          dataKey="date"
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
        <Legend wrapperStyle={{ fontFamily: 'var(--font-jb-mono)', fontSize: 11 }} />
        {types.map((t, i) => (
          <Bar key={t} dataKey={t} stackId="type" fill={PALETTE[i % PALETTE.length]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
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
