'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { UsageBucket } from '@/lib/stats/aggregates';

interface UsageBarChartProps {
  /** Precomputed single-dimension ranking (callsign usage, preamble) (#780). */
  data: UsageBucket[];
  /** How many top entries to chart. */
  topN?: number;
  emptyLabel?: string;
  /** Color token for the bars. */
  fill?: string;
  /** Y-axis category label width (px). */
  labelWidth?: number;
}

export function UsageBarChart({
  data,
  topN = 20,
  emptyLabel = 'No data yet.',
  fill = 'var(--color-accent)',
  labelWidth = 110,
}: UsageBarChartProps) {
  const charted = useMemo(() => data.slice(0, topN), [data, topN]);
  if (charted.length === 0) {
    return <EmptyChart label={emptyLabel} />;
  }
  return (
    <ResponsiveContainer>
      <BarChart data={charted} layout="vertical" margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="var(--border-1)" strokeDasharray="2 4" />
        <XAxis
          type="number"
          allowDecimals={false}
          tick={{ fill: 'var(--text-2)', fontSize: 11 }}
          stroke="var(--border-1)"
        />
        <YAxis
          type="category"
          dataKey="label"
          width={labelWidth}
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
        <Bar dataKey="count" fill={fill} />
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
