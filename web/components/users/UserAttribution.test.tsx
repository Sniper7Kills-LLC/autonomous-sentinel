import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UserAttribution } from './UserAttribution';
import type { UserLabel } from '@/lib/users/label';

const labelMock = vi.fn<(sub: string) => Promise<UserLabel>>();
vi.mock('@/lib/users/label', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getUserLabel: (sub: string): Promise<UserLabel> => labelMock(sub),
  };
});

describe('UserAttribution (#721)', () => {
  beforeEach(() => {
    labelMock.mockReset();
  });

  it('renders the null label without a link when sub is null', () => {
    render(
      <UserAttribution sub={null} prefix="Submitted by" nullLabel="SDR-derived / automated" />,
    );
    expect(screen.getByText('SDR-derived / automated')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(labelMock).not.toHaveBeenCalled();
  });

  it('resolves the display name and links to the profile route', async () => {
    labelMock.mockResolvedValue({ sub: 'sub-1', label: 'Sierra', piiBlanked: false });
    render(<UserAttribution sub="sub-1" prefix="Uploaded by" nullLabel="Unknown" />);
    await waitFor(() => expect(screen.getByText('Sierra')).toBeInTheDocument());
    const link = screen.getByRole('link', { name: 'Sierra' });
    expect(link).toHaveAttribute('href', '/users/view?id=sub-1');
  });

  it('falls back to the short sub before resolution / on failure', async () => {
    labelMock.mockResolvedValue({ sub: 'abcdefghijklmnop', label: 'abcdefgh…', piiBlanked: false });
    render(<UserAttribution sub="abcdefghijklmnop" prefix="Uploaded by" nullLabel="Unknown" />);
    // Optimistic short-sub label is shown immediately, before the resolve.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/users/view?id=abcdefghijklmnop');
    await waitFor(() => expect(screen.getByText('abcdefgh…')).toBeInTheDocument());
  });
});
