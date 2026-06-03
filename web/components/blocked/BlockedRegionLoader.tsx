'use client';

import { useEffect, useState } from 'react';
import {
  DEFAULT_BLOCKED_CONTENT,
  fetchBlockedContent,
  type BlockedRegionContent,
} from '@/lib/blocked/page';
import { BlockedRegionView } from './BlockedRegionView';

interface BlockedRegionLoaderProps {
  /** ISO-3166-1 alpha-2 from the route param or viewer-country header. */
  iso2: string | null;
}

/**
 * Client-side fetch wrapper for the public banned-region page (#202).
 *
 * The route-level server components own `metadata` (noindex) and the
 * header / param resolution; this resolves the per-country content via the
 * guest AppSync read (which needs the Amplify client + auth-mode probe,
 * both client-only) and renders the shared `BlockedRegionView`.
 *
 * It seeds with the generic default so a blocked visitor always sees a
 * complete page immediately, then swaps in custom content if one exists.
 * `fetchBlockedContent` never throws, so there is no error branch.
 */
export function BlockedRegionLoader({ iso2 }: BlockedRegionLoaderProps) {
  const [content, setContent] = useState<BlockedRegionContent>(DEFAULT_BLOCKED_CONTENT);

  useEffect(() => {
    let active = true;
    void fetchBlockedContent(iso2).then((resolved) => {
      if (active) setContent(resolved);
    });
    return () => {
      active = false;
    };
  }, [iso2]);

  return <BlockedRegionView content={content} />;
}
