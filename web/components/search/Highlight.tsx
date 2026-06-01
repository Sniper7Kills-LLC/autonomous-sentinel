import { Fragment } from 'react';
import { splitHighlight } from '@/lib/highlight';

interface HighlightProps {
  text: string;
  query: string;
}

/**
 * Renders `text` with every case-insensitive occurrence of `query`
 * wrapped in `<mark>`. The query is matched as a literal substring
 * (see `splitHighlight` — regex metacharacters are escaped), so an
 * arbitrary user query can never inject a pattern or throw.
 */
export function Highlight({ text, query }: HighlightProps) {
  const segments = splitHighlight(text, query);
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? <mark key={i}>{seg.text}</mark> : <Fragment key={i}>{seg.text}</Fragment>,
      )}
    </>
  );
}
