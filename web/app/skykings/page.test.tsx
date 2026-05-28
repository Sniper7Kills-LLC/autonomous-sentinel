import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SkykingsPage from './page';
import { listMessages } from '@/lib/messages/query';

vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock('@/lib/messages/query', () => ({
  listMessages: vi.fn().mockResolvedValue({ items: [], nextToken: null }),
}));
vi.mock('next/navigation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/skykings',
  };
});

describe('SkykingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forces SKYKING type filter against the data client', async () => {
    render(<SkykingsPage />);
    await waitFor(() => {
      expect(listMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({ type: 'SKYKING' }) as Record<string, unknown>,
        }),
      );
    });
  });

  it('hides the type select since the type is locked', () => {
    render(<SkykingsPage />);
    expect(screen.queryByLabelText(/type/i)).toBeNull();
  });
});
