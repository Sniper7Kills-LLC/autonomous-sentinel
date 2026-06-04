import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SearchResults } from './SearchResults';

const replace = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => params,
}));

vi.mock('@/lib/messages/search', () => ({
  searchMessages: vi.fn(),
}));

import { searchMessages } from '@/lib/messages/search';

const sampleItem = {
  id: 'm1',
  type: 'SKYKING' as const,
  broadcastTs: '2026-05-27T12:00:00Z',
  sender: 'MAINSAIL',
  receiver: 'ANCHOR',
  body: 'FOXTROT 14 AB',
  confidence: 0.9,
  flaggedForReview: false,
  publishedAt: '2026-05-27T12:30:00Z',
  submitterId: null,
};

describe('SearchResults', () => {
  beforeEach(() => {
    params = new URLSearchParams();
    replace.mockReset();
    vi.mocked(searchMessages).mockReset();
    vi.mocked(searchMessages).mockResolvedValue({ items: [], nextToken: null });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders the best-effort disclaimer banner with the #182 reference', () => {
    render(<SearchResults />);
    expect(screen.getByText(/may be slow on rare terms/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /182/ })).toBeInTheDocument();
  });

  it('runs a search for the q param and highlights the match', async () => {
    params = new URLSearchParams('q=foxtrot');
    vi.mocked(searchMessages).mockResolvedValue({ items: [sampleItem], nextToken: null });
    render(<SearchResults />);
    await waitFor(() => {
      expect(searchMessages).toHaveBeenCalledWith('foxtrot', expect.any(Object));
    });
    const marks = await screen.findAllByText(/foxtrot/i, { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
  });

  it('shows an empty/no-results state suggesting narrowing when q yields nothing', async () => {
    params = new URLSearchParams('q=zzz');
    vi.mocked(searchMessages).mockResolvedValue({ items: [], nextToken: null });
    render(<SearchResults />);
    await waitFor(() => {
      expect(screen.getByText(/no results/i)).toBeInTheDocument();
    });
  });

  it('does not call searchMessages when q is empty', async () => {
    params = new URLSearchParams();
    render(<SearchResults />);
    // Give effects a tick.
    await waitFor(() => {
      expect(screen.getByText(/enter a search term/i)).toBeInTheDocument();
    });
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('submitting the input navigates to /search?q=', () => {
    render(<SearchResults />);
    const input = screen.getByRole('searchbox', { name: /search query/i });
    fireEvent.change(input, { target: { value: 'skyking' } });
    fireEvent.submit(input);
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('q=skyking'));
  });

  it('shows a Load more button when a nextToken is returned', async () => {
    params = new URLSearchParams('q=foxtrot');
    vi.mocked(searchMessages).mockResolvedValue({ items: [sampleItem], nextToken: 'tok' });
    render(<SearchResults />);
    expect(await screen.findByRole('button', { name: /load more/i })).toBeInTheDocument();
  });
});
