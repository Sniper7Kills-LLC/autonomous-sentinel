import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { CallsignEditor } from './CallsignEditor';
import type { CallsignRow, CallsignInput } from '@/lib/admin/callsigns';

const listMock = vi.fn<() => Promise<CallsignRow[]>>();
const createMock = vi.fn<(input: CallsignInput) => Promise<CallsignRow>>();
const updateMock = vi.fn<(id: string, input: CallsignInput) => Promise<CallsignRow>>();
const approveMock = vi.fn<(id: string) => Promise<CallsignRow>>();
const deleteMock = vi.fn<(id: string) => Promise<void>>();

vi.mock('@/lib/admin/callsigns', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listCallsigns: () => listMock(),
    createCallsign: (input: CallsignInput) => createMock(input),
    updateCallsign: (id: string, input: CallsignInput) => updateMock(id, input),
    approveCallsign: (id: string) => approveMock(id),
    deleteCallsign: (id: string) => deleteMock(id),
  };
});

function row(p: Partial<CallsignRow>): CallsignRow {
  return {
    id: 'c1',
    normalized: 'SKYKING',
    variants: ['SKY KING', 'SKYKING'],
    source: 'ADMIN',
    confidence: null,
    approved: true,
    notes: 'primary node',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    ...p,
  };
}

const suggested = row({
  id: 'c2',
  normalized: 'MAINSAIL',
  variants: ['MAIN SAIL'],
  source: 'AI_SUGGESTED',
  confidence: 0.72,
  approved: false,
});

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([row({}), suggested]);
  createMock.mockReset().mockResolvedValue(row({ id: 'c3', normalized: 'NEW' }));
  updateMock.mockReset().mockResolvedValue(row({}));
  approveMock.mockReset().mockResolvedValue(row({ ...suggested, approved: true }));
  deleteMock.mockReset().mockResolvedValue(undefined);
});

describe('CallsignEditor — dictionary tab', () => {
  it('renders existing callsign rows', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    expect(screen.getByText('SKYKING')).toBeInTheDocument();
    expect(screen.getByText('SKY KING, SKYKING')).toBeInTheDocument();
    expect(screen.getByText('2 on file')).toBeInTheDocument();
  });

  it('opens the create form on + New', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New callsign' }));
    expect(screen.getByRole('form', { name: 'Create callsign' })).toBeInTheDocument();
  });

  it('blocks submit on empty normalized and does not call create', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New callsign' }));

    fireEvent.change(screen.getByLabelText('Normalized *'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.getByText('Normalized callsign is required.')).toBeInTheDocument(),
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('submits a valid create with parsed + uppercased variants and refetches', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New callsign' }));

    fireEvent.change(screen.getByLabelText('Normalized *'), { target: { value: 'foxtrot' } });
    fireEvent.change(screen.getByLabelText('Variants'), {
      target: { value: 'fox, FOX, foxtrot' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        normalized: 'FOXTROT',
        variants: ['FOX', 'FOXTROT'],
        source: 'ADMIN',
        approved: true,
        notes: null,
      }),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('requires a confirm step before delete', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());

    const targetRow = screen.getByText('SKYKING').closest('tr');
    if (!targetRow) throw new Error('expected the SKYKING row');
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Delete' }));
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('c1'));
  });

  it('loads an existing row into the edit form and updates', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());

    const targetRow = screen.getByText('SKYKING').closest('tr');
    if (!targetRow) throw new Error('expected the SKYKING row');
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Edit' }));
    const normalized = screen.getByLabelText('Normalized *');
    expect(normalized).toHaveValue('SKYKING');
    fireEvent.change(normalized, { target: { value: 'skyking-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ normalized: 'SKYKING-1' }),
      ),
    );
  });

  it('preserves a multi-word variant on an unchanged save (no silent split)', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());

    const targetRow = screen.getByText('SKYKING').closest('tr');
    if (!targetRow) throw new Error('expected the SKYKING row');
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Edit' }));
    // The form seeds "SKY KING, SKYKING"; save without editing it.
    expect(screen.getByLabelText('Variants')).toHaveValue('SKY KING, SKYKING');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ variants: ['SKY KING', 'SKYKING'] }),
      ),
    );
  });

  it('shows an empty state when no callsigns exist', async () => {
    listMock.mockResolvedValue([]);
    render(<CallsignEditor />);
    await waitFor(() =>
      expect(screen.getByText('No callsigns yet. Create the first one.')).toBeInTheDocument(),
    );
  });
});

describe('CallsignEditor — merge queue tab', () => {
  it('filters to AI-suggested / unapproved rows', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Merge queue/ }));
    const queue = await screen.findByTestId('cs-queue-table');
    expect(queue).toBeInTheDocument();
    expect(screen.getByText('MAINSAIL')).toBeInTheDocument();
    expect(screen.getByText('0.72')).toBeInTheDocument();
    // The approved ADMIN row is not in the queue.
    expect(screen.queryByText('SKYKING')).not.toBeInTheDocument();
  });

  it('approves a queued row via update and refetches', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Merge queue/ }));
    await screen.findByTestId('cs-queue-table');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('c2'));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('rejects a queued row via delete (no confirm needed) and refetches', async () => {
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Merge queue/ }));
    await screen.findByTestId('cs-queue-table');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('c2'));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('shows an empty queue state when nothing is pending', async () => {
    listMock.mockResolvedValue([row({})]);
    render(<CallsignEditor />);
    await waitFor(() => expect(screen.getByTestId('cs-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Merge queue/ }));
    await waitFor(() =>
      expect(
        screen.getByText(/Merge queue is empty\. AI-suggested entries appear here/),
      ).toBeInTheDocument(),
    );
  });
});
