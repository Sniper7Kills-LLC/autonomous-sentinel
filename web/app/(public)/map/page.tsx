'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { PropagationMap } from '@/components/map/PropagationMap';

/**
 * HF propagation map page (#83) at `/map`.
 *
 * Renders all admin-managed Transmitters + opted-in public SDRs on a
 * MapLibre + OpenStreetMap map, with an accessible sibling data table.
 * Client component because MapLibre is browser-only (WebGL); the static
 * export still prerenders the shell + the (empty-until-fetch) table.
 *
 * Deferred: NOAA SFI / K-index overlay → #84; map-based lat/lon picker
 * for the transmitter editor → #108.
 */
export default function MapPage() {
  return (
    <>
      <PageHeader
        eyebrow="§07 · Propagation"
        title="HF Propagation Map"
        lede="Known EAM transmitter sites and opted-in public SDR receivers. SDR locations are shown at the owner's chosen granularity and may be approximate."
      />
      <PropagationMap />
    </>
  );
}
