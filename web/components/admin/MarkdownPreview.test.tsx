import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownPreview } from './MarkdownPreview';

describe('MarkdownPreview', () => {
  it('renders headings, code blocks, lists and inline code from markdown', () => {
    const md = '# Title\n\nUse `{{TRANSCRIPT}}` here.\n\n- one\n- two\n\n```json\n{}\n```';
    render(<MarkdownPreview source={md} />);
    const preview = screen.getByTestId('markdown-preview');
    expect(preview.querySelector('h3')).toHaveTextContent('Title');
    expect(preview.querySelectorAll('li')).toHaveLength(2);
    expect(preview.querySelector('code')).toBeInTheDocument();
    expect(preview.querySelector('pre')).toHaveTextContent('{}');
  });

  it('does not inject raw HTML from the source', () => {
    render(<MarkdownPreview source={'<img src=x onerror=alert(1)>'} />);
    const preview = screen.getByTestId('markdown-preview');
    // the angle-bracket text is rendered as literal text, no <img> element
    expect(preview.querySelector('img')).toBeNull();
    expect(preview).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});
