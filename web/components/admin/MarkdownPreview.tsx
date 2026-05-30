'use client';

import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type InlineToken } from '@/lib/admin/markdown';
import styles from './AdminLinguistic.module.css';

interface MarkdownPreviewProps {
  source: string;
}

function renderInline(tokens: InlineToken[]): ReactNode {
  return tokens.map((t, i) => {
    if (t.kind === 'code') {
      return (
        <code key={i} className={styles.mdInlineCode}>
          {t.value}
        </code>
      );
    }
    if (t.kind === 'bold') {
      return <strong key={i}>{t.value}</strong>;
    }
    return <Fragment key={i}>{t.value}</Fragment>;
  });
}

/**
 * Read-only Markdown preview of the prompt body (#546).
 *
 * Renders the admin-authored Markdown prompt as structured elements via
 * the dependency-free tokenizer in `lib/admin/markdown.ts`. No raw HTML
 * is injected — every block maps to a React element — so there is no XSS
 * surface even though the source is operator-controlled.
 */
export function MarkdownPreview({ source }: MarkdownPreviewProps) {
  const blocks = parseMarkdown(source);
  return (
    <div className={styles.mdPreview} data-testid="markdown-preview">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading': {
            const level = Math.min(block.level + 2, 6);
            const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
            return (
              <Tag key={i} className={styles.mdHeading}>
                {renderInline(block.inline)}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre key={i} className={styles.mdCode}>
                <code>{block.value}</code>
              </pre>
            );
          case 'list':
            return block.ordered ? (
              <ol key={i} className={styles.mdList}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={i} className={styles.mdList}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'paragraph':
          default:
            return (
              <p key={i} className={styles.mdParagraph}>
                {renderInline(block.inline)}
              </p>
            );
        }
      })}
    </div>
  );
}
