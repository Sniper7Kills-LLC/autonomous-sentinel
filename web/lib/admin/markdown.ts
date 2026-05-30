/**
 * Tiny, dependency-free Markdown block tokenizer for the admin prompt
 * preview (#546).
 *
 * The Linguistic Logic fallback prompt body is authored in Markdown
 * (headings, fenced code blocks, lists, inline code/bold). The admin
 * editor renders a live preview so an operator sees the prompt the way
 * the model effectively reads it. We deliberately avoid pulling a full
 * Markdown dependency: the input is admin-authored (not user content),
 * and we only need a handful of block types. The renderer never injects
 * raw HTML — every token is mapped to a React element by
 * `MarkdownPreview`, so there is no XSS surface.
 *
 * Supported blocks: ATX headings (`#`..`######`), fenced code blocks
 * (```), unordered (`-`/`*`) and ordered (`1.`) lists, and paragraphs.
 * Inline: `**bold**` and `` `code` ``. Anything unrecognized passes
 * through as paragraph text.
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string };

export type MarkdownBlock =
  | { type: 'heading'; level: number; inline: InlineToken[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] }
  | { type: 'paragraph'; inline: InlineToken[] };

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*)/g;

/**
 * Split a single line of Markdown into inline tokens (text / inline
 * code / bold). Unmatched runs stay plain text.
 */
export function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ kind: 'text', value: line.slice(last, idx) });
    const seg = m[0];
    if (seg.startsWith('`')) {
      tokens.push({ kind: 'code', value: seg.slice(1, -1) });
    } else {
      tokens.push({ kind: 'bold', value: seg.slice(2, -2) });
    }
    last = idx + seg.length;
  }
  if (last < line.length) tokens.push({ kind: 'text', value: line.slice(last) });
  if (tokens.length === 0) tokens.push({ kind: 'text', value: '' });
  return tokens;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;

/**
 * Parse a Markdown string into an ordered list of block tokens for the
 * preview renderer.
 */
export function parseMarkdown(src: string): MarkdownBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = (fence[1] ?? '').trim() || null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '').length,
        inline: parseInline(heading[2] ?? ''),
      });
      i += 1;
      continue;
    }

    const isUl = UL_RE.test(line);
    const isOl = OL_RE.test(line);
    if (isUl || isOl) {
      const ordered = isOl;
      const re = ordered ? OL_RE : UL_RE;
      const items: InlineToken[][] = [];
      while (i < lines.length && re.test(lines[i] ?? '')) {
        const m = re.exec(lines[i] ?? '');
        items.push(parseInline(m?.[1] ?? ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (
        cur.trim() === '' ||
        FENCE_RE.test(cur) ||
        HEADING_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur)
      ) {
        break;
      }
      para.push(cur);
      i += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
  }

  return blocks;
}
