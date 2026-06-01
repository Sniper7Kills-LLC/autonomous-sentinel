'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
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
 * NOAA SFI / K-index propagation overlay (#84) toggles on via the layer
 * control; the `/map?layer=propagation` permalink enables it on load. The
 * search-param read sits inside a Suspense boundary so the static export
 * still prerenders without bailing out.
 *
 * Deferred: map-based lat/lon picker for the transmitter editor → #108.
 */
export default function MapPage() {
  return (
    <>
      <PageHeader
        eyebrow="§07 · Propagation"
        title="HF Propagation Map"
        lede="Known EAM transmitter sites and opted-in public SDR receivers. SDR locations are shown at the owner's chosen granularity and may be approximate."
      />
      <Suspense fallback={<PropagationMap />}>
        <MapWithLayerParam />
      </Suspense>
    </>
  );
}

function MapWithLayerParam() {
  const params = useSearchParams();
  const initialPropagation = params.get('layer') === 'propagation';
  return <PropagationMap initialPropagation={initialPropagation} />;
}
