import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { BannedRegionEditor } from './BannedRegionEditor';
import type { BannedRegionRow, BannedRegionInput } from '@/lib/admin/banned-regions';

const listMock = vi.fn<() => Promise<BannedRegionRow[]>>();
const createMock = vi.fn<(input: BannedRegionInput) => Promise<BannedRegionRow>>();
const updateMock = vi.fn<(input: BannedRegionInput) => Promise<BannedRegionRow>>();
const deleteMock = vi.fn<(countryCode: string) => Promise<void>>();

vi.mock('@/lib/admin/banned-regions', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listBannedRegionPages: () => listMock(),
    createBannedRegionPage: (input: BannedRegionInput) => createMock(input),
    updateBannedRegionPage: (input: BannedRegionInput) => updateMock(input),
    deleteBannedRegionPage: (countryCode: string) => deleteMock(countryCode),
  };
});

function row(p: Partial<BannedRegionRow>): BannedRegionRow {
  return {
    countryCode: 'US',
    title: 'Service unavailable',
    bodyMarkdown: '# Blocked\n\nNot available here.',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([row({})]);
  createMock.mockReset().mockResolvedValue(row({ countryCode: 'GB' }));
  updateMock.mockReset().mockResolvedValue(row({}));
  deleteMock.mockReset().mockResolvedValue(undefined);
});

describe('BannedRegionEditor', () => {
  it('renders a row of existing pages', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());
    expect(screen.getByText('US')).toBeInTheDocument();
    expect(screen.getByText('Service unavailable')).toBeInTheDocument();
    expect(screen.getByText('1 on file')).toBeInTheDocument();
  });

  it('opens the create form on + New', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New page' }));
    expect(screen.getByRole('form', { name: 'Create banned-region page' })).toBeInTheDocument();
  });

  it('blocks submit on a bad country code and does not call create', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New page' }));

    fireEvent.change(screen.getByLabelText('Country code *'), { target: { value: 'USA' } });
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Blocked' } });
    fireEvent.change(screen.getByLabelText('Body markdown *'), { target: { value: 'Body text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(
        screen.getByText('Country code must be two letters (ISO-3166-1 alpha-2).'),
      ).toBeInTheDocument(),
    );
    // maxLength caps the input at 2, but the validator is the real gate.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('updates the markdown preview as the body changes', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New page' }));

    fireEvent.change(screen.getByLabelText('Body markdown *'), {
      target: { value: '# Hello region' },
    });
    const preview = screen.getByTestId('markdown-preview');
    await waitFor(() => expect(within(preview).getByText('Hello region')).toBeInTheDocument());
  });

  it('does not execute raw HTML injected into the markdown body', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New page' }));

    fireEvent.change(screen.getByLabelText('Body markdown *'), {
      target: { value: '<script>alert(1)</script><iframe src="x"></iframe>' },
    });
    const preview = screen.getByTestId('markdown-preview');
    // No real <script> / <iframe> element is created — the source renders
    // as inert text via the tokenizer (no dangerouslySetInnerHTML).
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelector('iframe')).toBeNull();
    expect(preview.textContent).toContain('<script>alert(1)</script>');
  });

  it('submits a valid create and refetches', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New page' }));

    fireEvent.change(screen.getByLabelText('Country code *'), { target: { value: 'gb' } });
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Unavailable' } });
    fireEvent.change(screen.getByLabelText('Body markdown *'), {
      target: { value: 'Sorry, not here.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        countryCode: 'GB',
        title: 'Unavailable',
        bodyMarkdown: 'Sorry, not here.',
        enabled: true,
      }),
    );
    // initial load + reload after create
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('requires a confirm step before delete', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('US'));
  });

  it('loads an existing row into the edit form with a read-only country code and updates', async () => {
    render(<BannedRegionEditor />);
    await waitFor(() => expect(screen.getByTestId('br-table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const country = screen.getByLabelText('Country code *');
    expect(country).toHaveValue('US');
    expect(country).toHaveAttribute('readonly');

    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ countryCode: 'US', title: 'Updated title' }),
      ),
    );
  });

  it('shows an empty state when no pages exist', async () => {
    listMock.mockResolvedValue([]);
    render(<BannedRegionEditor />);
    await waitFor(() =>
      expect(
        screen.getByText('No banned-region pages yet. Create the first one.'),
      ).toBeInTheDocument(),
    );
  });
});
