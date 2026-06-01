'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { loadMapData } from '@/lib/map/query';
import { formatFrequencies, granularityLabel, type MapPoint } from '@/lib/map/points';
import styles from './PropagationMap.module.css';

/**
 * HF propagation map (#83) — MapLibre GL + free OpenStreetMap raster tiles.
 *
 * Hard constraint (CLAUDE.md → Stack → Map): MapLibre + OSM only, no
 * Mapbox / Google. Tiles come straight from the OSM Foundation tile
 * server with proper attribution per their tile-usage policy.
 *
 * Two marker layers, toggleable:
 *   - Transmitters (amber) — admin-managed broadcast sites, popups carry
 *     name / callsign / frequencies.
 *   - Public SDRs (cyan) — opted-in receivers, popups note the location is
 *     blurred to the owner's granularity.
 *
 * Accessibility: every plotted point is also rendered in a sibling
 * `<table>` so keyboard-only / screen-reader users get the same data
 * without the canvas (WCAG 2.1 AA — the map is not the only path to it).
 *
 * The WebGL glue is deliberately thin and isolated inside the effect:
 * `maplibre-gl` touches `window` + WebGL, neither of which exist under
 * the static export build or jsdom tests. We dynamic-import it in the
 * effect and tear the instance down on unmount. The pure projection
 * logic lives in `lib/map/points.ts` and is unit-tested there.
 *
 * Deferred: NOAA SFI / K-index propagation overlay → #84 (a third toggle
 * slot is reserved in the controls). Map-based lat/lon picker for the
 * transmitter editor → tie-in for #108.
 */

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_MAX_ZOOM = 19;

const TRANSMITTER_COLOR = '#f5a623';
const SDR_COLOR = '#21c0c0';

type Status = 'loading' | 'ready' | 'error';

/** Escape user/admin text before it goes into a popup's innerHTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function popupHtml(p: MapPoint): string {
  const lines: string[] = [`<strong>${escapeHtml(p.name)}</strong>`];
  if (p.type === 'transmitter') {
    if (p.meta.callsign) lines.push(`Callsign: ${escapeHtml(p.meta.callsign)}`);
    lines.push(`Freqs: ${escapeHtml(formatFrequencies(p.meta.frequencyKhzList))}`);
  } else {
    lines.push(`SDR &middot; ${escapeHtml(granularityLabel(p.meta.granularity))}`);
  }
  if (p.meta.notes) lines.push(escapeHtml(p.meta.notes));
  return lines.map((l) => `<div>${l}</div>`).join('');
}

export function PropagationMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<MlMarker[]>([]);

  const [points, setPoints] = useState<MapPoint[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [showTransmitters, setShowTransmitters] = useState(true);
  const [showSdrs, setShowSdrs] = useState(true);

  // Load the data (pure-ish — no WebGL). Runs even under jsdom.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadMapData();
        if (cancelled) return;
        setPoints(data.points);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Initialize the MapLibre instance once the host is mounted. Isolated
  // dynamic import keeps WebGL out of SSR / static export / jsdom.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    void (async () => {
      try {
        const maplibre = (await import('maplibre-gl')).default;
        await import('maplibre-gl/dist/maplibre-gl.css');
        if (disposed || !hostRef.current) return;

        const map = new maplibre.Map({
          container: hostRef.current,
          style: {
            version: 8,
            sources: {
              osm: {
                type: 'raster',
                tiles: [OSM_TILE_URL],
                tileSize: 256,
                maxzoom: OSM_MAX_ZOOM,
                attribution: OSM_ATTRIBUTION,
              },
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
          },
          center: [-40, 30],
          zoom: 1.5,
        });
        map.addControl(new maplibre.NavigationControl(), 'top-right');
        mapRef.current = map;
      } catch {
        // WebGL unavailable (e.g. headless) — the accessible table still
        // renders the data, so degrade silently.
      }
    })();

    return () => {
      disposed = true;
      for (const m of markersRef.current) {
        try {
          m.remove();
        } catch {
          /* noop */
        }
      }
      markersRef.current = [];
      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch {
          /* noop */
        }
        mapRef.current = null;
      }
    };
  }, []);

  // (Re)draw markers when points or layer toggles change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;

    void (async () => {
      const maplibre = (await import('maplibre-gl')).default;
      if (cancelled || !mapRef.current) return;

      for (const m of markersRef.current) {
        try {
          m.remove();
        } catch {
          /* noop */
        }
      }
      markersRef.current = [];

      for (const p of points) {
        if (p.type === 'transmitter' && !showTransmitters) continue;
        if (p.type === 'sdr' && !showSdrs) continue;
        try {
          const popup = new maplibre.Popup({ offset: 12 }).setHTML(popupHtml(p));
          const marker = new maplibre.Marker({
            color: p.type === 'transmitter' ? TRANSMITTER_COLOR : SDR_COLOR,
          })
            .setLngLat([p.lon, p.lat])
            .setPopup(popup)
            .addTo(map);
          markersRef.current.push(marker);
        } catch {
          /* noop */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [points, showTransmitters, showSdrs]);

  const visiblePoints = points.filter(
    (p) => (p.type === 'transmitter' && showTransmitters) || (p.type === 'sdr' && showSdrs),
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.controls} role="group" aria-label="Map layers">
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showTransmitters}
            onChange={(e) => setShowTransmitters(e.target.checked)}
          />
          <span className={`${styles.swatch} ${styles.swatchTransmitter}`} aria-hidden />
          Transmitters
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showSdrs}
            onChange={(e) => setShowSdrs(e.target.checked)}
          />
          <span className={`${styles.swatch} ${styles.swatchSdr}`} aria-hidden />
          Public SDRs
        </label>
        {/* Propagation overlay (NOAA SFI / K-index) toggle reserved for #84. */}
      </div>

      <div
        ref={hostRef}
        className={styles.mapHost}
        role="application"
        aria-label="HF propagation map showing transmitter and public SDR locations. A data table with the same points follows below."
      >
        {status !== 'ready' && (
          <div className={styles.status}>
            {status === 'loading'
              ? 'Loading map data…'
              : 'Could not load map data. The data table below may be empty.'}
          </div>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>
            All plotted locations ({visiblePoints.length} shown). Keyboard- and
            screen-reader-accessible equivalent of the map markers above.
          </caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Name</th>
              <th scope="col">Latitude</th>
              <th scope="col">Longitude</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {visiblePoints.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={5}>
                  {status === 'loading'
                    ? 'Loading…'
                    : 'No locations to display for the selected layers.'}
                </td>
              </tr>
            ) : (
              visiblePoints.map((p) => (
                <tr key={`${p.type}:${p.id}`}>
                  <td>{p.type === 'transmitter' ? 'Transmitter' : 'Public SDR'}</td>
                  <td>{p.name}</td>
                  <td>{p.lat.toFixed(4)}</td>
                  <td>{p.lon.toFixed(4)}</td>
                  <td>
                    {p.type === 'transmitter'
                      ? [
                          p.meta.callsign ? `Callsign ${p.meta.callsign}` : null,
                          `Freqs ${formatFrequencies(p.meta.frequencyKhzList)}`,
                          p.meta.notes,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : [granularityLabel(p.meta.granularity), p.meta.notes]
                          .filter(Boolean)
                          .join(' · ')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
