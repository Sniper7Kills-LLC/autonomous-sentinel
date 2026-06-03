import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BlockedRegionView } from './BlockedRegionView';
import type { BlockedRegionContent } from '@/lib/blocked/page';

function content(p: Partial<BlockedRegionContent> = {}): BlockedRegionContent {
  return {
    countryCode: null,
    title: 'Access restricted in your region',
    bodyMarkdown: 'Access from your region is **restricted**.',
    isCustom: false,
    ...p,
  };
}

describe('BlockedRegionView', () => {
  it('renders the title as a heading and the markdown body', () => {
    render(<BlockedRegionView content={content()} />);
    expect(
      screen.getByRole('heading', { name: 'Access restricted in your region' }),
    ).toBeInTheDocument();
    // Markdown body is rendered (bold token → <strong>), not raw markdown.
    expect(screen.getByTestId('markdown-preview')).toHaveTextContent(
      'Access from your region is restricted.',
    );
    expect(screen.getByText('restricted')).toBeInTheDocument();
  });

  it('shows the default-message note when isCustom is false', () => {
    render(<BlockedRegionView content={content({ isCustom: false })} />);
    expect(screen.getByTestId('default-note')).toBeInTheDocument();
  });

  it('does not show the default note when content is custom', () => {
    render(
      <BlockedRegionView
        content={content({
          countryCode: 'US',
          title: 'No access from the US',
          bodyMarkdown: 'Custom message.',
          isCustom: true,
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No access from the US' })).toBeInTheDocument();
    expect(screen.queryByTestId('default-note')).not.toBeInTheDocument();
  });
});
