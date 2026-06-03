import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BlockedRegionLoader } from './BlockedRegionLoader';
import type { BlockedRegionContent } from '@/lib/blocked/page';

const searchParams = new URLSearchParams();
const fetchMock = vi.fn<(iso2: string | null) => Promise<BlockedRegionContent>>();

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/blocked/page', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchBlockedContent: (iso2: string | null) => fetchMock(iso2),
  };
});

function content(p: Partial<BlockedRegionContent>): BlockedRegionContent {
  return {
    countryCode: null,
    title: 'Access restricted in your region',
    bodyMarkdown: 'default body',
    isCustom: false,
    ...p,
  };
}

beforeEach(() => {
  searchParams.delete('country');
  fetchMock.mockReset().mockResolvedValue(content({}));
});

describe('BlockedRegionLoader (#202)', () => {
  it('reads the country query param and fetches that page', async () => {
    searchParams.set('country', 'RU');
    fetchMock.mockResolvedValue(
      content({ countryCode: 'RU', title: 'Blocked in RU', isCustom: true }),
    );
    render(<BlockedRegionLoader />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('RU'));
    expect(await screen.findByText('Blocked in RU')).toBeInTheDocument();
  });

  it('falls back to the default when no country param is present', async () => {
    render(<BlockedRegionLoader />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(null));
    expect(screen.getByText('Access restricted in your region')).toBeInTheDocument();
  });
});
