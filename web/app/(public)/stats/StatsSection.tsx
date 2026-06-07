'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import Link from 'next/link';
import { ChartShell } from '@/components/charts/ChartShell';
import { DailyCountChart } from '@/components/charts/DailyCountChart';
import { DailyTypeCountChart } from '@/components/charts/DailyTypeCountChart';
import { CharacterFrequencyChart } from '@/components/charts/CharacterFrequencyChart';
import { CodewordFrequencyChart } from '@/components/charts/CodewordFrequencyChart';
import { UsageBarChart } from '@/components/charts/UsageBarChart';
import { StreakList } from '@/components/charts/StreakList';
import { useChartAggregate } from '@/components/charts/StatsLoader';
import {
  STAT_METRICS,
  toCharFrequency,
  toCodewordFrequency,
  toRanking,
  toDailyTypeCounts,
  toStreaks,
} from '@/lib/stats/aggregates';
import styles from './StatsSection.module.css';

const DEEP_LINKS: { href: string; label: string }[] = [
  { href: '/stats', label: 'Overview' },
  { href: '/stats/daily-counts', label: 'Daily counts' },
  { href: '/stats/character-counts', label: 'Character counts' },
  { href: '/stats/codeword-counts', label: 'Codeword counts' },
];

export function StatsDeepNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Stats sections" className={styles.deepNav}>
      {DEEP_LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`${styles.deepNavLink} ${active ? styles.deepNavActive : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Per-metric panels — each reads one precomputed ChartAggregate
 * partition and renders its chart. Used both small (overview grid) and
 * full-size (deep pages).
 * ------------------------------------------------------------------ */

function DailyTypePanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.DAILY_COUNT);
  const { dates, types } = useMemo(() => toDailyTypeCounts(rows), [rows]);
  return (
    <Async loading={loading} error={error}>
      <DailyTypeCountChart dates={dates} types={types} />
    </Async>
  );
}

function DailyTotalsPanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.DAILY_COUNT);
  const data = useMemo(
    () => toDailyTypeCounts(rows).dates.map((d) => ({ date: d.date, count: d.total })),
    [rows],
  );
  return (
    <Async loading={loading} error={error}>
      <DailyCountChart data={data} />
    </Async>
  );
}

function CharFreqPanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.CHAR_FREQ_ALLSTATIONS);
  const data = useMemo(() => toCharFrequency(rows), [rows]);
  return (
    <Async loading={loading} error={error}>
      <CharacterFrequencyChart data={data} />
    </Async>
  );
}

function CodewordPanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.CODEWORD_SKYKING);
  const data = useMemo(() => toCodewordFrequency(rows), [rows]);
  return (
    <Async loading={loading} error={error}>
      <CodewordFrequencyChart data={data} />
    </Async>
  );
}

function CallsignPanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.CALLSIGN_USAGE);
  const data = useMemo(() => toRanking(rows), [rows]);
  return (
    <Async loading={loading} error={error}>
      <UsageBarChart data={data} emptyLabel="No callsign usage yet." fill="var(--color-success)" />
    </Async>
  );
}

function PreamblePanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.PREAMBLE_FIRST2);
  const data = useMemo(() => toRanking(rows), [rows]);
  return (
    <Async loading={loading} error={error}>
      <UsageBarChart
        data={data}
        emptyLabel="No preamble data yet."
        fill="var(--color-warning)"
        labelWidth={48}
      />
    </Async>
  );
}

function StreaksPanel() {
  const { rows, loading, error } = useChartAggregate(STAT_METRICS.DAILY_COUNT);
  const streaks = useMemo(() => toStreaks(rows), [rows]);
  return (
    <Async loading={loading} error={error}>
      <StreakList streaks={streaks} />
    </Async>
  );
}

export function StatsOverview() {
  return (
    <>
      <p className={styles.statusLine}>
        Precomputed corpus-wide aggregates (excludes deleted, flagged + unpublished messages).
      </p>
      <div className={styles.indexGrid}>
        <ChartShell title="Daily counts by type" eyebrow="§03.A" small>
          <DailyTypePanel />
        </ChartShell>
        <ChartShell title="Character frequency" eyebrow="§03.B" small>
          <CharFreqPanel />
        </ChartShell>
        <ChartShell title="Codeword frequency" eyebrow="§03.C" small>
          <CodewordPanel />
        </ChartShell>
        <ChartShell title="Callsign usage" eyebrow="§03.D" small>
          <CallsignPanel />
        </ChartShell>
        <ChartShell title="Preamble (first 2)" eyebrow="§03.E" small>
          <PreamblePanel />
        </ChartShell>
        <ChartShell title="Consecutive-day streaks" eyebrow="§03.F" small>
          <StreaksPanel />
        </ChartShell>
      </div>
      <p className={styles.indexFootnote}>
        All charts read precomputed counters from the ChartAggregate table — full-corpus, updated as
        messages are published, corrected, or deleted. No client-side aggregation.
      </p>
    </>
  );
}

export function StatsDailyCounts() {
  return (
    <>
      <ChartShell
        eyebrow="§03.A"
        title="Daily message counts by type"
        note={
          <>
            One stacked bar per UTC date, split by message type. Rebroadcasts of the same Message
            body still count once per received broadcast — multi-SDR captures of the same broadcast
            collapse upstream via content-hash dedupe, not here.
          </>
        }
      >
        <DailyTypePanel />
      </ChartShell>
      <ChartShell eyebrow="§03.A2" title="Daily totals (all types)">
        <DailyTotalsPanel />
      </ChartShell>
    </>
  );
}

export function StatsCharacterCounts() {
  return (
    <ChartShell
      eyebrow="§03.B"
      title="Character frequency"
      note={
        <>
          How many times each character (A–Z, 0–9) appears across all published ALLSTATIONS message
          bodies — a per-character frequency ranking of the decoded alphabet, not a body-length
          distribution.
        </>
      }
    >
      <CharFreqPanel />
    </ChartShell>
  );
}

export function StatsCodewordCounts() {
  return (
    <ChartShell
      eyebrow="§03.C"
      title="Codeword frequency"
      note={
        <>
          How many times each distinct codeword (contiguous [A-Z0-9] groups of 3+ characters) was
          used across all published SKYKING message bodies, ranked.
        </>
      }
    >
      <CodewordPanel />
    </ChartShell>
  );
}

function Async({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  if (loading) return <Loading />;
  if (error) return <ErrorBox text={error} />;
  return <>{children}</>;
}

function Loading() {
  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-2)',
        fontFamily: 'var(--font-jb-mono)',
        fontSize: '0.85rem',
      }}
      aria-busy
    >
      Loading…
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--danger)',
        fontFamily: 'var(--font-jb-mono)',
        fontSize: '0.85rem',
      }}
      role="alert"
    >
      Error: {text}
    </div>
  );
}
