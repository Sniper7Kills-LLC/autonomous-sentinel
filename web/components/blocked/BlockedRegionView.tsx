'use client';

import { MarkdownPreview } from '@/components/admin/MarkdownPreview';
import type { BlockedRegionContent } from '@/lib/blocked/page';
import styles from '@/app/blocked/blocked.module.css';

interface BlockedRegionViewProps {
  content: BlockedRegionContent;
}

/**
 * Shared presentation for the public banned-region landing page (#202).
 *
 * Both `/blocked` (no-iso fallback, country resolved from the
 * `cloudfront-viewer-country` header) and `/blocked/[iso2]` render through
 * this so the markup stays in one place. The body is operator-authored
 * Markdown rendered via `MarkdownPreview` — token → React element, never
 * `dangerouslySetInnerHTML`, so there is no XSS surface even though the
 * source is admin-controlled.
 *
 * When `isCustom` is false the generic default copy is shown along with a
 * subtle note that no region-specific message was configured.
 */
export function BlockedRegionView({ content }: BlockedRegionViewProps) {
  return (
    <main className={styles.shell}>
      <section className={styles.panel} aria-labelledby="blocked-title">
        <p className={styles.eyebrow}>Access notice</p>
        <h1 id="blocked-title" className={styles.title}>
          {content.title}
        </h1>
        <div className={styles.body}>
          <MarkdownPreview source={content.bodyMarkdown} />
        </div>
        {!content.isCustom && (
          <p className={styles.defaultNote} data-testid="default-note">
            This is the default access notice; no region-specific message is configured.
          </p>
        )}
      </section>
    </main>
  );
}
