import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SettingsIndexPage from './page';

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

describe('SettingsIndexPage dashboard (#788)', () => {
  it('links every account settings surface, grouped', () => {
    render(<SettingsIndexPage />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const href of [
      '/settings/profile',
      '/settings/security',
      '/uploads',
      '/settings/sdrs',
      '/settings/notifications',
      '/settings/delete',
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  it('renders the group headings', () => {
    render(<SettingsIndexPage />);
    for (const h of ['Account', 'Contributions', 'Preferences', 'Danger zone']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    }
  });
});
