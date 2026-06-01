'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchSpaceWeather, type FetchLike, type SpaceWeather } from './noaa';

/** Default client-side refresh cadence — ~5 min, well under NOAA's update rate. */
export const REFRESH_MS = 5 * 60 * 1000;

export interface SpaceWeatherState {
  /** Last successful reading, or null until the first success. */
  data: SpaceWeather | null;
  /** True while a fetch is in flight (and no prior data exists). */
  loading: boolean;
  /** True when the displayed `data` is from a prior fetch and the latest failed. */
  stale: boolean;
}

interface Options {
  /** When false, no fetching happens (e.g. overlay toggled off — saves NOAA quota). */
  enabled: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
  /** Override refresh cadence (tests). */
  refreshMs?: number;
}

/**
 * Poll NOAA space weather while `enabled`. Holds the last-known reading and
 * flags it stale when a refresh fails, so the UI never blanks (#84
 * failure/stale path). No fetching occurs while disabled, satisfying the
 * "no NOAA calls when the overlay is off" acceptance criterion.
 */
export function useSpaceWeather({
  enabled,
  fetchImpl,
  refreshMs = REFRESH_MS,
}: Options): SpaceWeatherState {
  const [data, setData] = useState<SpaceWeather | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  // Keep the latest data accessible inside the interval without re-subscribing.
  const dataRef = useRef<SpaceWeather | null>(null);
  dataRef.current = data;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function load() {
      if (!dataRef.current) setLoading(true);
      try {
        const sw = await fetchSpaceWeather(fetchImpl);
        if (cancelled) return;
        setData(sw);
        setStale(false);
      } catch {
        if (cancelled) return;
        // Keep prior data; mark stale only if we had something to show.
        setStale(dataRef.current !== null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const id = setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, fetchImpl, refreshMs]);

  return { data, loading, stale };
}
