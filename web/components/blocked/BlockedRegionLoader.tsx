'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  DEFAULT_BLOCKED_CONTENT,
  fetchBlockedContent,
  type BlockedRegionContent,
} from '@/lib/blocked/page';
import { BlockedRegionView } from './BlockedRegionView';

/**
 * Client-side fetch wrapper for the public banned-region page (#202).
 *
 * The site is a static export (`output: 'export'`), so there is no request
 * runtime to read the `cloudfront-viewer-country` header server-side and no
 * dynamic `[iso2]` segment. Following the app convention (see
 * `/messages/view?id=`), the country rides as a `?country=<ISO2>` query param
 * on the single static `/blocked` page and is read client-side here. Absent /
 * invalid → `fetchBlockedContent` resolves to the generic default.
 *
 * Automatic country→page routing (rewriting `/blocked` to
 * `/blocked?country=<viewer-country>`) needs a CloudFront viewer-request
 * function — tracked as a follow-up; not in this static-export build.
 *
 * Seeds with the generic default so a blocked visitor always sees a complete
 * page immediately, then swaps in custom content if one exists.
 * `fetchBlockedContent` never throws, so there is no error branch. Must render
 * inside a `<Suspense>` boundary (useSearchParams requirement under export).
 */
export function BlockedRegionLoader() {
  const params = useSearchParams();
  const country = params.get('country');
  const [content, setContent] = useState<BlockedRegionContent>(DEFAULT_BLOCKED_CONTENT);

  useEffect(() => {
    let active = true;
    void fetchBlockedContent(country).then((resolved) => {
      if (active) setContent(resolved);
    });
    return () => {
      active = false;
    };
  }, [country]);

  return <BlockedRegionView content={content} />;
}
