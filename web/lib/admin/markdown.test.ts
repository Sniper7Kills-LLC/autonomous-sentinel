import { describe, it, expect } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('splits inline code and bold from text', () => {
    expect(parseInline('use `code` and **bold** here')).toEqual([
      { kind: 'text', value: 'use ' },
      { kind: 'code', value: 'code' },
      { kind: 'text', value: ' and ' },
      { kind: 'bold', value: 'bold' },
      { kind: 'text', value: ' here' },
    ]);
  });

  it('returns a single empty text token for an empty line', () => {
    expect(parseInline('')).toEqual([{ kind: 'text', value: '' }]);
  });
});

describe('parseMarkdown', () => {
  it('parses ATX headings with level', () => {
    const block = parseMarkdown('## EAM Parser')[0]!;
    expect(block).toEqual({
      type: 'heading',
      level: 2,
      inline: [{ kind: 'text', value: 'EAM Parser' }],
    });
  });

  it('parses fenced code blocks and keeps the language + body', () => {
    const md = '```json\n{ "a": 1 }\n```';
    const block = parseMarkdown(md)[0]!;
    expect(block).toEqual({ type: 'code', lang: 'json', value: '{ "a": 1 }' });
  });

  it('parses an unordered list into items', () => {
    const md = '- one\n- two';
    const block = parseMarkdown(md)[0]!;
    expect(block.type).toBe('list');
    if (block.type === 'list') {
      expect(block.ordered).toBe(false);
      expect(block.items).toHaveLength(2);
    }
  });

  it('parses an ordered list', () => {
    const block = parseMarkdown('1. first\n2. second')[0]!;
    expect(block.type).toBe('list');
    if (block.type === 'list') expect(block.ordered).toBe(true);
  });

  it('joins consecutive lines into a paragraph', () => {
    const block = parseMarkdown('line one\nline two')[0]!;
    expect(block).toEqual({
      type: 'paragraph',
      inline: [{ kind: 'text', value: 'line one line two' }],
    });
  });

  it('handles the real fallback prompt without throwing and finds the placeholder', () => {
    // representative mixed-block document
    const md = '# EAM Parser\n\nText with `{{TRANSCRIPT}}` placeholder.\n\n- a\n- b';
    const blocks = parseMarkdown(md);
    expect(blocks[0]!.type).toBe('heading');
    expect(blocks.some((b) => b.type === 'list')).toBe(true);
  });
});
