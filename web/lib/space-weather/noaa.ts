/**
 * NOAA SWPC space-weather access for the propagation overlay (#84).
 *
 * Architecture note (deviates from #84's original proposal): the issue
 * proposed a `noaa-fetch` Lambda + a `SpaceWeather` DDB cache + an AppSync
 * query. We instead fetch the NOAA SWPC JSON DIRECTLY FROM THE CLIENT. The
 * SWPC endpoints are public, key-less, and CORS-enabled
 * (`access-control-allow-origin: *`), and the site is a static export with
 * no server, so a client fetch avoids new Amplify infra + deploy risk and
 * fits the project's cost-aware stance.
 *
 * DEFERRED (future optimization, still tracked under #84): a server-side
 * poller + cache (Lambda + DDB singleton + AppSync query/subscription) would
 * cut per-client NOAA traffic and let us push live updates. Build it only if
 * scale demands it — not at v1.
 *
 * The pure parsers + the propagation-band classifier are unit-tested here;
 * the network call is thin and injectable so tests never hit the network.
 */

/** SWPC F10.7cm solar flux feed. Each row carries a `flux` value + a timestamp. */
export const SFI_URL = 'https://services.swpc.noaa.gov/json/f107_cm_flux.json';
/** SWPC planetary K-index (1-minute) feed. Rows carry `kp_index`/`estimated_kp`. */
export const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

/** Qualitative propagation band derived from SFI + Kp. */
export type PropagationBandName = 'Quiet' | 'Unsettled' | 'Active' | 'Storm';

export interface PropagationBand {
  name: PropagationBandName;
  /** Hex band color (chip background swatch). */
  color: string;
  /**
   * Hex text color to render ON `color`. Chosen so the (color, textColor)
   * pair clears WCAG AA 4.5:1 for normal text — asserted in noaa.test.ts via
   * the shared `lib/a11y/contrast` helper. Light bands take dark text; the
   * dark Storm band takes white.
   */
  textColor: string;
  /** One-line human description of conditions. */
  description: string;
}

export interface SpaceWeather {
  /** Solar flux index (F10.7cm), or null when unavailable. */
  sfi: number | null;
  /** Planetary K-index (0–9), or null when unavailable. */
  kp: number | null;
  /** Qualitative band classification. */
  band: PropagationBand;
  /** When this reading was fetched (epoch ms). */
  fetchedAt: number;
}

type Json = unknown;

/** Coerce a value to a finite number, or null. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse an epoch-ms timestamp out of the common SWPC field shapes. */
function rowTime(row: Record<string, unknown>): number {
  const raw =
    row['time_tag'] ?? row['time-tag'] ?? row['timestamp'] ?? row['date'] ?? row['observed'];
  if (typeof raw === 'string' || typeof raw === 'number') {
    // SWPC times are UTC; some feeds omit the trailing 'Z'. Normalize.
    const s =
      typeof raw === 'string' && /\d{2}:\d{2}/.test(raw) && !/[zZ+]/.test(raw)
        ? raw.replace(' ', 'T') + 'Z'
        : String(raw);
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * Given an array of SWPC rows, return the row with the latest timestamp.
 * Falls back to the last array element when no row carries a parseable time.
 */
function latestRow(payload: Json): Record<string, unknown> | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const rows = payload.filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
  );
  const first = rows[0];
  if (!first) return null;
  let best = first;
  let bestTime = rowTime(best);
  let sawTime = bestTime !== Number.NEGATIVE_INFINITY;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const t = rowTime(row);
    if (t !== Number.NEGATIVE_INFINITY) sawTime = true;
    if (t >= bestTime) {
      best = row;
      bestTime = t;
    }
  }
  // No row had a parseable time — the feeds are time-ordered, so take the last.
  if (!sawTime) return rows[rows.length - 1] ?? best;
  return best;
}

/** Parse the latest solar flux index out of the SWPC f107 payload. */
export function parseLatestSfi(payload: Json): number | null {
  const row = latestRow(payload);
  if (!row) return null;
  return toNumber(row['flux'] ?? row['f10.7'] ?? row['f107']);
}

/** Parse the latest planetary K-index out of the SWPC planetary-k payload. */
export function parseLatestKp(payload: Json): number | null {
  const row = latestRow(payload);
  if (!row) return null;
  return toNumber(row['kp_index'] ?? row['estimated_kp'] ?? row['kp']);
}

/** Dark text for the light bands (Quiet/Unsettled/Active/Unknown). */
const TEXT_DARK = '#0b0f14';
/** White text for the dark Storm band. */
const TEXT_LIGHT = '#ffffff';

const BAND_QUIET: PropagationBand = {
  name: 'Quiet',
  color: '#2e9e5b',
  textColor: TEXT_DARK,
  description: 'Geomagnetically quiet — HF propagation is favorable.',
};
const BAND_UNSETTLED: PropagationBand = {
  name: 'Unsettled',
  color: '#c8a415',
  textColor: TEXT_DARK,
  description: 'Unsettled field — HF mostly usable, some fading possible.',
};
const BAND_ACTIVE: PropagationBand = {
  name: 'Active',
  color: '#d97316',
  textColor: TEXT_DARK,
  description: 'Active field — degraded HF, expect absorption on lower bands.',
};
const BAND_STORM: PropagationBand = {
  name: 'Storm',
  color: '#d63d3d',
  textColor: TEXT_LIGHT,
  description: 'Geomagnetic storm — poor HF, frequent blackouts likely.',
};
const BAND_UNKNOWN: PropagationBand = {
  name: 'Unsettled',
  color: '#7a8088',
  textColor: TEXT_DARK,
  description: 'Space-weather data unavailable — conditions unknown.',
};

/**
 * Classify a qualitative propagation band from SFI + Kp.
 *
 * Kp dominates the geomagnetic disturbance picture and so drives the band:
 *   Kp < 3  → Quiet
 *   3 ≤ Kp < 4 → Unsettled
 *   4 ≤ Kp < 5 → Active
 *   Kp ≥ 5  → Storm  (NOAA G1+ storm scale starts at Kp 5)
 * A low solar flux (SFI < 70, i.e. a weak solar maximum / few open bands)
 * nudges an otherwise-Quiet field down to Unsettled, reflecting thin HF
 * openings even when the field is calm. When Kp is unknown we cannot judge
 * the field, so we return an explicit "unknown" band (gray).
 */
export function propagationBand(sfi: number | null, kp: number | null): PropagationBand {
  if (kp === null) return BAND_UNKNOWN;
  if (kp >= 5) return BAND_STORM;
  if (kp >= 4) return BAND_ACTIVE;
  if (kp >= 3) return BAND_UNSETTLED;
  // Quiet field, but a weak sun (low SFI) means few usable HF bands.
  if (sfi !== null && sfi < 70) return BAND_UNSETTLED;
  return BAND_QUIET;
}

/** Injectable fetch signature so tests never touch the network. */
export type FetchLike = (url: string) => Promise<Response>;

const defaultFetch: FetchLike = (url) => fetch(url, { cache: 'no-store' });

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<Json> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`NOAA fetch failed (${res.status}) for ${url}`);
  return (await res.json()) as Json;
}

/**
 * Fetch current space weather from SWPC. SFI + Kp are fetched independently
 * so one feed failing still yields a partial reading (the missing value is
 * null and the band falls back accordingly). Throws only when BOTH feeds
 * fail, so callers can keep the last-known reading on total failure.
 */
export async function fetchSpaceWeather(
  fetchImpl: FetchLike = defaultFetch,
  now: () => number = Date.now,
): Promise<SpaceWeather> {
  const [sfiResult, kpResult] = await Promise.allSettled([
    fetchJson(SFI_URL, fetchImpl),
    fetchJson(KP_URL, fetchImpl),
  ]);

  if (sfiResult.status === 'rejected' && kpResult.status === 'rejected') {
    throw new Error(
      `NOAA space-weather fetch failed: SFI (${String(sfiResult.reason)}), Kp (${String(
        kpResult.reason,
      )})`,
    );
  }

  const sfi = sfiResult.status === 'fulfilled' ? parseLatestSfi(sfiResult.value) : null;
  const kp = kpResult.status === 'fulfilled' ? parseLatestKp(kpResult.value) : null;

  return { sfi, kp, band: propagationBand(sfi, kp), fetchedAt: now() };
}

/** Format an epoch-ms instant as `HH:MM` UTC for the stale-time note. */
export function formatUtcHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Display string for a value that may be null. */
function valueOrDash(n: number | null): string {
  return n === null ? '—' : String(n);
}

/**
 * Build the accessible, screen-reader-friendly summary sentence for a reading
 * (the non-chip text form required by #84). `stale` toggles the "as of HH:MM
 * UTC" qualifier. Returns the "unavailable" copy when there is no reading.
 */
export function spaceWeatherSummary(reading: SpaceWeather | null, stale: boolean): string {
  if (!reading) return 'Space weather unavailable.';
  const sfi = valueOrDash(reading.sfi);
  const kp = valueOrDash(reading.kp);
  const base = `Solar flux index ${sfi}, planetary K-index ${kp}. Conditions: ${reading.band.name} — ${reading.band.description}`;
  if (stale) {
    return `${base} (stale, fetched ${formatUtcHHMM(reading.fetchedAt)} UTC)`;
  }
  return base;
}
