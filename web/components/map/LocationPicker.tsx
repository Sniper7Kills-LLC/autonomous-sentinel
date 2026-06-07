'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import styles from './LocationPicker.module.css';

/**
 * Reusable MapLibre + OSM location picker (#785).
 *
 * Click or drag the marker to set lat/lon. Displays current coordinates.
 * Browser-only (dynamic import + CSS; renders a placeholder during SSR
 * and static export builds — same pattern as PropagationMap).
 *
 * Hard constraint (CLAUDE.md → Map): MapLibre + OSM tiles only, no Mapbox.
 * Tiles and attribution from OpenStreetMap Foundation tile server.
 */

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_MAX_ZOOM = 19;

// Default center: mid-Atlantic (a neutral starting point for an HF-radio app)
const DEFAULT_CENTER: [number, number] = [-40, 30];
const DEFAULT_ZOOM = 1.5;

export interface LocationPickerProps {
  latitude: number | null;
  longitude: number | null;
  onChange: (lat: number, lng: number) => void;
  /** Optional label shown above the map */
  label?: string;
}

/**
 * Round a coordinate to 6 decimal places (sub-metre precision).
 */
function roundCoord(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function LocationPicker({ latitude, longitude, onChange, label }: LocationPickerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markerRef = useRef<MlMarker | null>(null);
  // Track whether the marker has been added to the map — avoids probing
  // MapLibre's private `_map` field (not in the public API).
  const markerAddedRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    latitude !== null && longitude !== null && latitude !== undefined && longitude !== undefined
      ? { lat: latitude, lng: longitude }
      : null,
  );

  // Track whether we're in a browser environment (static export safety)
  useEffect(() => {
    setMounted(true);
  }, []);

  // Initialize the MapLibre map once mounted
  useEffect(() => {
    if (!mounted) return;
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    void (async () => {
      try {
        const maplibre = (await import('maplibre-gl')).default;
        await import('maplibre-gl/dist/maplibre-gl.css');
        if (disposed || !hostRef.current) return;

        const initialCenter: [number, number] =
          latitude !== null && longitude !== null &&
          latitude !== undefined && longitude !== undefined
            ? [longitude, latitude]
            : DEFAULT_CENTER;

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
          center: initialCenter,
          zoom:
            latitude !== null && longitude !== null &&
            latitude !== undefined && longitude !== undefined
              ? 8
              : DEFAULT_ZOOM,
        });

        map.addControl(new maplibre.NavigationControl(), 'top-right');

        // Create a draggable marker if we have an initial position
        const marker = new maplibre.Marker({ draggable: true, color: '#21c0c0' });

        if (
          latitude !== null && longitude !== null &&
          latitude !== undefined && longitude !== undefined
        ) {
          marker.setLngLat([longitude, latitude]).addTo(map);
          markerAddedRef.current = true;
        }

        markerRef.current = marker;

        // Drag-end: update coords
        marker.on('dragend', () => {
          const lngLat = marker.getLngLat();
          const lat = roundCoord(lngLat.lat);
          const lng = roundCoord(lngLat.lng);
          setCoords({ lat, lng });
          onChange(lat, lng);
        });

        // Click on map: move marker + update coords
        map.on('click', (e) => {
          const lat = roundCoord(e.lngLat.lat);
          const lng = roundCoord(e.lngLat.lng);
          marker.setLngLat([lng, lat]);
          if (!markerAddedRef.current) {
            marker.addTo(map);
            markerAddedRef.current = true;
          }
          setCoords({ lat, lng });
          onChange(lat, lng);
        });

        mapRef.current = map;
      } catch {
        // WebGL unavailable (SSR, headless) — degrade silently.
        // The parent form's numeric text fallback provides accessibility.
      }
    })();

    return () => {
      disposed = true;
      markerAddedRef.current = false;
      if (markerRef.current) {
        try {
          markerRef.current.remove();
        } catch {
          /* noop */
        }
        markerRef.current = null;
      }
      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch {
          /* noop */
        }
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Sync external prop changes into the marker (e.g. form reset)
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    if (latitude === null || longitude === null || latitude === undefined || longitude === undefined)
      return;
    const lat = roundCoord(latitude);
    const lng = roundCoord(longitude);
    markerRef.current.setLngLat([lng, lat]);
    if (!markerAddedRef.current) {
      markerRef.current.addTo(mapRef.current);
      markerAddedRef.current = true;
    }
    setCoords({ lat, lng });
  }, [latitude, longitude]);

  if (!mounted) {
    // SSR / static-export placeholder — avoids hydration mismatch
    return (
      <div className={styles.placeholder} aria-label="Map loading…">
        <span className={styles.placeholderText}>Map loading…</span>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {label && <p className={styles.label}>{label}</p>}
      <div
        ref={hostRef}
        className={styles.mapHost}
        role="application"
        aria-label="Location picker map — click or drag the marker to set a location"
      />
      <p className={styles.coords} aria-live="polite">
        {coords !== null
          ? `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`
          : 'Click the map to set a location'}
      </p>
    </div>
  );
}
