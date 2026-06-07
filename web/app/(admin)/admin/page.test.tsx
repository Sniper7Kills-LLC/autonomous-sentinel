import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdminIndexPage from './page';

vi.mock('@/components/admin/AdminGate', () => ({
  AdminGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

describe('AdminIndexPage dashboard (#546)', () => {
  it('links every admin tool, grouped', () => {
    render(<AdminIndexPage />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const href of [
      '/admin/linguistic',
      '/admin/dlq',
      '/admin/transmitters',
      '/admin/callsigns',
      '/admin/moderation',
      '/admin/reputation',
      '/admin/bans',
      '/admin/banned-regions',
      '/admin/users',
      '/admin/audit',
      '/admin/playback',
      '/admin/budget',
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  it('shows fine-tune as coming soon (not a link)', () => {
    render(<AdminIndexPage />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /fine-tune/i })).not.toBeInTheDocument();
  });
});
