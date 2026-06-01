'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ChartShell } from '@/components/charts/ChartShell';
import { DailyCountChart } from '@/components/charts/DailyCountChart';
import { HistogramChart } from '@/components/charts/HistogramChart';
import { useStatsMessages } from '@/components/charts/StatsLoader';
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

export function StatsOverview() {
  const { messages, loading, error } = useStatsMessages(500);
  return (
    <>
      <p className={styles.statusLine}>
        {loading
          ? 'Loading the most recent 500 Messages…'
          : error
            ? `Error: ${error}`
            : `Aggregating ${messages.length} recent Messages.`}
      </p>
      <div className={styles.indexGrid}>
        <ChartShell title="Daily counts" eyebrow="§03.A" small>
          <DailyCountChart messages={messages} />
        </ChartShell>
        <ChartShell title="Character counts" eyebrow="§03.B" small>
          <HistogramChart messages={messages} field="characterCount" />
        </ChartShell>
        <ChartShell title="Codeword counts" eyebrow="§03.C" small>
          <HistogramChart messages={messages} field="codewordCount" />
        </ChartShell>
      </div>
      <p className={styles.indexFootnote}>
        Aggregations run client-side over the most recent 500 Messages. Deep pages render the same
        chart at full size with a wider sample window when DDB GSIs land.
      </p>
    </>
  );
}

export function StatsDailyCounts() {
  const { messages, loading, error } = useStatsMessages(1000);
  return (
    <ChartShell
      eyebrow="§03.A"
      title="Daily message counts"
      note={
        <>
          One bar per UTC date. Rebroadcasts of the same Message body still count once per received
          broadcast — multi-SDR captures of the same broadcast collapse upstream via content-hash
          dedupe, not here.
        </>
      }
    >
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox text={error} />
      ) : (
        <DailyCountChart messages={messages} />
      )}
    </ChartShell>
  );
}

export function StatsCharacterCounts() {
  const { messages, loading, error } = useStatsMessages(1000);
  return (
    <ChartShell
      eyebrow="§03.B"
      title="Character-count distribution"
      note={
        <>
          ALLSTATIONS broadcasts have a canonical 30-character body; 22 and 28 also occur in-spec.
          Off-spec lengths are flagged on the detail page.
        </>
      }
    >
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox text={error} />
      ) : (
        <HistogramChart messages={messages} field="characterCount" />
      )}
    </ChartShell>
  );
}

export function StatsCodewordCounts() {
  const { messages, loading, error } = useStatsMessages(1000);
  return (
    <ChartShell
      eyebrow="§03.C"
      title="Codeword-count distribution"
      note={
        <>
          Codeword count is the number of pronounceable codeword groups in the body — distinct from
          character count, which is the raw character length of the same body.
        </>
      }
    >
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox text={error} />
      ) : (
        <HistogramChart messages={messages} field="codewordCount" />
      )}
    </ChartShell>
  );
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
