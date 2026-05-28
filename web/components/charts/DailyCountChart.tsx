'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { aggregateDailyCounts } from '@/lib/messages/aggregations';
import type { DisplayMessage } from '@/lib/messages/types';

interface DailyCountChartProps {
  messages: DisplayMessage[];
}

export function DailyCountChart({ messages }: DailyCountChartProps) {
  const data = useMemo(() => aggregateDailyCounts(messages), [messages]);
  if (data.length === 0) {
    return <EmptyChart label="No daily-count data yet." />;
  }
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
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
        <Bar dataKey="count" fill="var(--color-accent)" />
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
