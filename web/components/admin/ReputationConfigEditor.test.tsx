import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReputationConfigEditor } from './ReputationConfigEditor';
import type { ReputationConfigRow, ReputationConfigValues } from '@/lib/admin/reputation-config';

const getMock = vi.fn<() => Promise<ReputationConfigRow | null>>();
const saveMock =
  vi.fn<
    (
      input: ReputationConfigValues,
      opts: { exists: boolean; notes?: string },
    ) => Promise<ReputationConfigRow>
  >();

vi.mock('@/lib/admin/reputation-config', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getReputationConfig: () => getMock(),
    saveReputationConfig: (
      input: ReputationConfigValues,
      opts: { exists: boolean; notes?: string },
    ) => saveMock(input, opts),
  };
});

function row(p: Partial<ReputationConfigRow> = {}): ReputationConfigRow {
  return {
    key: 'default',
    base: 1,
    perValidatedSubmission: 0.1,
    validatedCap: 4,
    perAcceptedCorrection: 0.5,
    correctionCap: 5,
    moderatorBonus: 1,
    adminBonus: 2,
    netWeightCap: 5,
    quorum: 2,
    confidenceThreshold: 0.8,
    notes: '',
    updatedAt: null,
    ...p,
  };
}

beforeEach(() => {
  getMock.mockReset();
  saveMock.mockReset().mockImplementation((input) => Promise.resolve(row(input)));
});

describe('ReputationConfigEditor', () => {
  it('seeds the form with CLAUDE.md defaults when no row exists', async () => {
    getMock.mockResolvedValue(null);
    render(<ReputationConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Base weight')).toBeInTheDocument());
    expect(screen.getByLabelText('Base weight')).toHaveValue(1);
    expect(screen.getByLabelText('Per validated submission')).toHaveValue(0.1);
    expect(screen.getByLabelText('Admin bonus')).toHaveValue(2);
  });

  it('renders the live preview weight for the default sample user', async () => {
    getMock.mockResolvedValue(null);
    render(<ReputationConfigEditor />);
    // default sample: 10 subs (cap 4 → 0.4) + 3 corr (1.5) + member = 1 + 0.4 + 1.5 = 2.90
    await waitFor(() => expect(screen.getByTestId('preview-weight')).toHaveTextContent('2.90'));
  });

  it('updates the preview when a coefficient changes', async () => {
    getMock.mockResolvedValue(null);
    render(<ReputationConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Base weight')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Base weight'), { target: { value: '2' } });
    // 2 + 0.4 + 1.5 = 3.90
    expect(screen.getByTestId('preview-weight')).toHaveTextContent('3.90');
  });

  it('applies the net weight cap in the preview', async () => {
    getMock.mockResolvedValue(null);
    render(<ReputationConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Role')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Validated submissions'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Accepted corrections'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    // 1 + 0.4 + 2.5 + 2 = 5.9 → cap 5.00
    expect(screen.getByTestId('preview-weight')).toHaveTextContent('5.00');
  });

  it('creates on first save (exists=false)', async () => {
    getMock.mockResolvedValue(null);
    render(<ReputationConfigEditor />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]).toMatchObject({ exists: false });
  });

  it('updates when a row already exists (exists=true)', async () => {
    getMock.mockResolvedValue(row({ base: 2 }));
    render(<ReputationConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Base weight')).toHaveValue(2));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]).toMatchObject({ exists: true });
  });

  it('blocks save and shows a field error on invalid input', async () => {
    getMock.mockResolvedValue(null);
    render(<ReputationConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Base weight')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Per validated submission'), {
      target: { value: '-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Must not be negative.')).toBeInTheDocument());
    expect(saveMock).not.toHaveBeenCalled();
  });
});
