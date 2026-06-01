/**
 * Pure transforms for the HF propagation map (#83).
 *
 * The map glue (MapLibre + WebGL) lives in `components/map/PropagationMap.tsx`
 * and is untestable under jsdom. Everything that decides *what* gets plotted —
 * the row → `MapPoint` projection and the null-coordinate filtering — lives
 * here so it can be unit-tested without a GL context.
 *
 * Sources:
 *   - `client.models.Transmitter.list` → admin-managed broadcast sites
 *     (lat/lon required server-side, but we still guard defensively).
 *   - `client.queries.listSdrPublic` → opted-in public SDRs. The backing
 *     Lambda (`listSdrPublicLambda`, #286) already filters soft-deleted +
 *     non-public rows and blurs lat/lon to the owner's `locationGranularity`
 *     (EXACT → exact, CITY → 1dp, REGION → 0dp, unset → null). We do not
 *     re-blur here — we only drop points the Lambda left without coordinates.
 */

export type MapPointType = 'transmitter' | 'sdr';

/** A render-ready point on the propagation map. */
export interface MapPoint {
  type: MapPointType;
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Type-specific extras surfaced in popups + the accessible table. */
  meta: {
    /** Transmitter callsign, when known. */
    callsign?: string | null;
    /** Transmitter frequencies (kHz). */
    frequencyKhzList?: number[] | null;
    /** Free-form admin / owner notes. */
    notes?: string | null;
    /**
     * SDR coordinate granularity — `null`/absent for transmitters.
     * Surfaced so the UI can flag that an SDR location is blurred.
     */
    granularity?: SdrGranularity | null;
  };
}

export type SdrGranularity = 'EXACT' | 'CITY' | 'REGION';

/** Structural shape of a `Transmitter` list row (no Schema dependency). */
export interface RawTransmitter {
  id?: string | null;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  callsign?: string | null;
  frequencyKhzList?: (number | null)[] | null;
  notes?: string | null;
}

/** Structural shape of a `listSdrPublic` result row. */
export interface RawSdrPublic {
  id?: string | null;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationGranularity?: string | null;
  notes?: string | null;
}

const GRANULARITIES: readonly SdrGranularity[] = ['EXACT', 'CITY', 'REGION'];

function isGranularity(v: unknown): v is SdrGranularity {
  return typeof v === 'string' && (GRANULARITIES as readonly string[]).includes(v);
}

/** A finite number in a plausible lat/lon range — drops null/NaN/Infinity. */
function isPlottableCoord(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
}

function hasCoords(lat: unknown, lon: unknown): boolean {
  return isPlottableCoord(lat, 90) && isPlottableCoord(lon, 180);
}

/** Normalize a frequency list, dropping null entries. */
function cleanFreqs(list: (number | null)[] | null | undefined): number[] | null {
  if (!list) return null;
  const out = list.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return out.length ? out : null;
}

/** Project Transmitter rows → MapPoints, dropping any without valid coords. */
export function transmittersToPoints(rows: RawTransmitter[]): MapPoint[] {
  const out: MapPoint[] = [];
  for (const r of rows) {
    if (!hasCoords(r.latitude, r.longitude)) continue;
    out.push({
      type: 'transmitter',
      id: r.id ?? '',
      name: r.name?.trim() || 'Unnamed transmitter',
      lat: r.latitude as number,
      lon: r.longitude as number,
      meta: {
        callsign: r.callsign ?? null,
        frequencyKhzList: cleanFreqs(r.frequencyKhzList),
        notes: r.notes ?? null,
      },
    });
  }
  return out;
}

/**
 * Project public SDR rows → MapPoints, dropping any the Lambda left without
 * coordinates (granularity blur can null both lat + lon).
 */
export function sdrsToPoints(rows: RawSdrPublic[]): MapPoint[] {
  const out: MapPoint[] = [];
  for (const r of rows) {
    if (!hasCoords(r.latitude, r.longitude)) continue;
    out.push({
      type: 'sdr',
      id: r.id ?? '',
      name: r.name?.trim() || 'Unnamed SDR',
      lat: r.latitude as number,
      lon: r.longitude as number,
      meta: {
        notes: r.notes ?? null,
        granularity: isGranularity(r.locationGranularity) ? r.locationGranularity : null,
      },
    });
  }
  return out;
}

/** Merge transmitter + SDR rows into a single plottable point list. */
export function toMapPoints(transmitters: RawTransmitter[], sdrs: RawSdrPublic[]): MapPoint[] {
  return [...transmittersToPoints(transmitters), ...sdrsToPoints(sdrs)];
}

/** Human-readable frequency string for popups + the accessible table. */
export function formatFrequencies(list: number[] | null | undefined): string {
  if (!list || !list.length) return '—';
  return list.map((khz) => `${khz} kHz`).join(', ');
}

/** Short note on how blurred an SDR's plotted location is. */
export function granularityLabel(g: SdrGranularity | null | undefined): string {
  switch (g) {
    case 'EXACT':
      return 'exact location';
    case 'CITY':
      return 'city-level (approx.)';
    case 'REGION':
      return 'region-level (approx.)';
    default:
      return 'approximate location';
  }
}
