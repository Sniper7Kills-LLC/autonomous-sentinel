'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { PlaybackConfigEditor } from '@/components/admin/PlaybackConfigEditor';

/**
 * Admin · Playback rate-limit tuning (#114).
 *
 * Tune the per-IP playback rate limits (requests/minute, bytes/hour,
 * signed-URL TTL) without a code change. Persists to the admin-only
 * `PlaybackConfig` singleton.
 *
 * Create/update is gated to the `admin` Cognito group server-side, so the
 * editor sits behind `<AdminGate>`: moderators who can reach the
 * `(admin)` group still see the admin-required notice. The AppSync model
 * enforces authorization regardless; the gate only decides what to render.
 *
 * STATS dashboards (most-played audio, top-playing users) are deferred —
 * they need playback counters emitted by the playback / signed-URL
 * pipeline (#91 / #205), which does not exist yet. The editor shows a
 * placeholder until those counters land. Edge enforcement of the limits
 * is phase 6 (#205).
 */
export default function AdminPlaybackPage() {
  return (
    <>
      <PageHeader
        eyebrow="§10 · Admin"
        title="Playback limits"
        lede="Tune the per-IP playback rate limits before saving. Administrators only. Playback stats arrive once the pipeline emits counters."
      />
      <AdminGate>
        <PlaybackConfigEditor />
      </AdminGate>
    </>
  );
}
