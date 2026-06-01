import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TransmitterEditor } from './TransmitterEditor';
import type { TransmitterRow, TransmitterInput } from '@/lib/admin/transmitters';

const listMock = vi.fn<() => Promise<TransmitterRow[]>>();
const createMock = vi.fn<(input: TransmitterInput) => Promise<TransmitterRow>>();
const updateMock = vi.fn<(id: string, input: TransmitterInput) => Promise<TransmitterRow>>();
const deleteMock = vi.fn<(id: string) => Promise<void>>();

vi.mock('@/lib/admin/transmitters', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listTransmitters: () => listMock(),
    createTransmitter: (input: TransmitterInput) => createMock(input),
    updateTransmitter: (id: string, input: TransmitterInput) => updateMock(id, input),
    deleteTransmitter: (id: string) => deleteMock(id),
  };
});

function row(p: Partial<TransmitterRow>): TransmitterRow {
  return {
    id: 't1',
    name: 'Andrews',
    latitude: 38.81,
    longitude: -76.87,
    callsign: 'SKYKING',
    frequencyKhzList: [8992, 11175],
    notes: 'primary node',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([row({})]);
  createMock.mockReset().mockResolvedValue(row({ id: 't2', name: 'New' }));
  updateMock.mockReset().mockResolvedValue(row({}));
  deleteMock.mockReset().mockResolvedValue(undefined);
});

describe('TransmitterEditor', () => {
  it('renders a row of existing transmitters', async () => {
    render(<TransmitterEditor />);
    await waitFor(() => expect(screen.getByTestId('tx-table')).toBeInTheDocument());
    expect(screen.getByText('Andrews')).toBeInTheDocument();
    expect(screen.getByText('SKYKING')).toBeInTheDocument();
    expect(screen.getByText('8992, 11175')).toBeInTheDocument();
    expect(screen.getByText('1 on file')).toBeInTheDocument();
  });

  it('opens the create form on + New', async () => {
    render(<TransmitterEditor />);
    await waitFor(() => expect(screen.getByTestId('tx-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New transmitter' }));
    expect(screen.getByRole('form', { name: 'Create transmitter' })).toBeInTheDocument();
  });

  it('blocks submit on bad coordinates and does not call create', async () => {
    render(<TransmitterEditor />);
    await waitFor(() => expect(screen.getByTestId('tx-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New transmitter' }));

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Bad Site' } });
    fireEvent.change(screen.getByLabelText('Latitude *'), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText('Longitude *'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.getByText('Latitude must be between −90 and 90.')).toBeInTheDocument(),
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('submits a valid create and refetches', async () => {
    render(<TransmitterEditor />);
    await waitFor(() => expect(screen.getByTestId('tx-table')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '+ New transmitter' }));

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Croughton' } });
    fireEvent.change(screen.getByLabelText('Latitude *'), { target: { value: '51.95' } });
    fireEvent.change(screen.getByLabelText('Longitude *'), { target: { value: '-1.18' } });
    fireEvent.change(screen.getByLabelText('Frequencies (kHz)'), {
      target: { value: '8992, 11175' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'Croughton',
        latitude: 51.95,
        longitude: -1.18,
        callsign: null,
        frequencyKhzList: [8992, 11175],
        notes: null,
      }),
    );
    // initial load + reload after create
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('requires a confirm step before delete', async () => {
    render(<TransmitterEditor />);
    await waitFor(() => expect(screen.getByTestId('tx-table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMock).not.toHaveBeenCalled();
    // confirm appears
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('t1'));
  });

  it('loads an existing row into the edit form and updates', async () => {
    render(<TransmitterEditor />);
    await waitFor(() => expect(screen.getByTestId('tx-table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Name *');
    expect(name).toHaveValue('Andrews');
    fireEvent.change(name, { target: { value: 'Andrews AFB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ name: 'Andrews AFB', latitude: 38.81 }),
      ),
    );
  });

  it('shows an empty state when no transmitters exist', async () => {
    listMock.mockResolvedValue([]);
    render(<TransmitterEditor />);
    await waitFor(() =>
      expect(screen.getByText('No transmitters yet. Create the first one.')).toBeInTheDocument(),
    );
  });
});
