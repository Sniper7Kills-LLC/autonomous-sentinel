'use client';

import { useCallback, useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { PageHeader } from '@/components/layout/PageHeader';
import { fetchCallerGroups, isModeratorOrAdmin, isAdmin } from '@/lib/auth/roles';
import {
  aggregateCost,
  aggregateRevenue,
  windowStartDate,
  formatBytes,
  fetchCostSnapshots,
  fetchRevenueSnapshots,
  runCostSnapshotNow,
  type CostAggregate,
  type RevenueAggregate,
} from '@/lib/cost/transparency';

const WINDOW_DAYS = 30;
/**
 * After the admin queues a sync, the worker runs fire-and-forget via
 * EventBridge. Refetch cost data once after this delay so the page
 * surfaces freshly-written rows without a manual reload.
 */
const SYNC_REFETCH_DELAY_MS = 60_000;

type SyncState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'queued' }
  | { status: 'error'; message: string };

export default function TransparencyPage() {
  const [cost, setCost] = useState<CostAggregate | null>(null);
  const [revenue, setRevenue] = useState<RevenueAggregate | null>(null);
  const [showRevenue, setShowRevenue] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [sync, setSync] = useState<SyncState>({ status: 'idle' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCost = useCallback(async (): Promise<void> => {
    const fromDate = windowStartDate(new Date(), WINDOW_DAYS);
    const costRows = await fetchCostSnapshots(fromDate);
    setCost(aggregateCost(costRows, fromDate));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fromDate = windowStartDate(new Date(), WINDOW_DAYS);

    void (async () => {
      try {
        const costRows = await fetchCostSnapshots(fromDate);
        if (!cancelled) setCost(aggregateCost(costRows, fromDate));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load cost data.');
      } finally {
        if (!cancelled) setLoading(false);
      }

      // Revenue read is admin/moderator only; the on-demand "Sync now"
      // trigger is admin-only (stricter). The server enforces both — this
      // just avoids guaranteed authz errors for everyone else.
      try {
        const groups = await fetchCallerGroups();
        if (!cancelled && isAdmin(groups)) setShowSync(true);
        if (!isModeratorOrAdmin(groups)) return;
        if (!cancelled) setShowRevenue(true);
        const revRows = await fetchRevenueSnapshots(fromDate);
        if (!cancelled) setRevenue(aggregateRevenue(revRows, fromDate));
      } catch {
        // Not signed in / not authorized — leave the panels hidden.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSync = useCallback(async (): Promise<void> => {
    setSync({ status: 'running' });
    try {
      await runCostSnapshotNow();
      setSync({ status: 'queued' });
      // The worker runs async via EventBridge — refetch once after a
      // short delay so the freshly-written rows appear.
      setTimeout(() => {
        void loadCost();
      }, SYNC_REFETCH_DELAY_MS);
    } catch (e) {
      setSync({ status: 'error', message: e instanceof Error ? e.message : 'Sync failed.' });
    }
  }, [loadCost]);

  return (
    <>
      <PageHeader
        eyebrow="§ Cost transparency"
        title="What it costs to run eam.watch"
        lede="Open-source operations promise: this is the AWS spend behind the site over the last 30 days, broken down per service so you can see what your activity costs Sniper7Kills LLC."
      />

      <section aria-labelledby="cost-panel-heading">
        <h2 id="cost-panel-heading">AWS spend (last {WINDOW_DAYS} days)</h2>

        {showSync && (
          <div>
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={sync.status === 'running'}
            >
              {sync.status === 'running' ? 'Syncing…' : 'Sync now'}
            </button>
            {sync.status === 'queued' && (
              <span role="status"> Sync queued — refresh in ~1 min.</span>
            )}
            {sync.status === 'error' && <span role="alert"> Sync failed: {sync.message}</span>}
          </div>
        )}

        {loading && <p>Loading cost data…</p>}
        {error && <p role="alert">Could not load cost data: {error}</p>}

        {cost && !error && (
          <>
            {cost.byService.length === 0 ? (
              <p>
                No cost data yet. The daily snapshot worker starts populating this page once it has
                run; figures appear from the first full day onward.
              </p>
            ) : (
              <>
                <p>
                  <strong>Total: ${cost.totalUsd.toFixed(2)}</strong> across {cost.byService.length}{' '}
                  AWS service{cost.byService.length === 1 ? '' : 's'} since {cost.fromDate}.
                </p>

                <div style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer>
                    <BarChart data={cost.byService} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis type="category" dataKey="service" width={180} />
                      <Tooltip />
                      <Bar dataKey="usd" name="USD" fill="#4f9da6" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <h3>Storage breakdown (S3 by prefix)</h3>
                {cost.s3Prefixes.length === 0 ? (
                  <p>No storage breakdown captured yet.</p>
                ) : (
                  <ul>
                    {cost.s3Prefixes.map((p) => (
                      <li key={p.prefix}>
                        <code>{p.prefix}</code> — {formatBytes(p.bytes)} across{' '}
                        {p.objects.toLocaleString()} object{p.objects === 1 ? '' : 's'}
                      </li>
                    ))}
                  </ul>
                )}

                <h3>Compute breakdown (Lambda by function)</h3>
                {cost.lambdaFunctions.length === 0 ? (
                  <p>No compute breakdown captured yet.</p>
                ) : (
                  <ul>
                    {cost.lambdaFunctions.map((f) => (
                      <li key={f.functionName}>
                        <code>{f.functionName}</code> — {f.invocations.toLocaleString()} invocation
                        {f.invocations === 1 ? '' : 's'}, {f.durationGbSeconds.toFixed(1)} compute-s
                      </li>
                    ))}
                  </ul>
                )}

                <h3>What am I looking at?</h3>
                <p>
                  Each bar is one AWS service&apos;s share of the bill. Storage is mostly recordings
                  (originals you upload plus the web-optimized copies we generate); compute is the
                  pipeline that transcribes and parses every broadcast. We snapshot these numbers
                  once a day, so the figures are up to ~24 hours stale — this is a transparency
                  page, not an ops dashboard.
                </p>
              </>
            )}
          </>
        )}
      </section>

      {showRevenue && (
        <section aria-labelledby="revenue-panel-heading">
          <h2 id="revenue-panel-heading">Revenue (admin / moderator only)</h2>
          {!revenue || !revenue.hasData ? (
            <p>
              No revenue data yet. Stripe donations and subscriptions are not wired up at v1; this
              panel populates once the payment integration ships.
            </p>
          ) : (
            <>
              <p>
                <strong>Total: ${revenue.totalUsd.toFixed(2)}</strong> since {revenue.fromDate}.
              </p>
              <ul>
                {revenue.byCategory.map((c) => (
                  <li key={c.category}>
                    {c.category}: ${c.usd.toFixed(2)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
