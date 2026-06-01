import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BudgetConfigEditor } from './BudgetConfigEditor';
import type { BudgetConfigRow, BudgetConfigValues } from '@/lib/admin/budget-config';

const getMock = vi.fn<() => Promise<BudgetConfigRow | null>>();
const saveMock =
  vi.fn<
    (
      input: BudgetConfigValues,
      opts: { exists: boolean; notes?: string },
    ) => Promise<BudgetConfigRow>
  >();

vi.mock('@/lib/admin/budget-config', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getBudgetConfig: () => getMock(),
    saveBudgetConfig: (input: BudgetConfigValues, opts: { exists: boolean; notes?: string }) =>
      saveMock(input, opts),
  };
});

function row(p: Partial<BudgetConfigRow> = {}): BudgetConfigRow {
  return {
    key: 'default',
    softUsd: 50,
    loudUsd: 100,
    hardUsd: 200,
    notificationEmail: 'ops@example.com',
    softBannerEnabled: false,
    loudBannerEnabled: true,
    hardThrottleEnabled: true,
    hardPageEnabled: true,
    notes: '',
    updatedAt: null,
    ...p,
  };
}

beforeEach(() => {
  getMock.mockReset();
  saveMock.mockReset().mockImplementation((input) => Promise.resolve(row(input)));
});

describe('BudgetConfigEditor', () => {
  it('seeds the form with CLAUDE.md defaults when no row exists', async () => {
    getMock.mockResolvedValue(null);
    render(<BudgetConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Soft threshold (USD)')).toBeInTheDocument());
    expect(screen.getByLabelText('Soft threshold (USD)')).toHaveValue(50);
    expect(screen.getByLabelText('Loud threshold (USD)')).toHaveValue(100);
    expect(screen.getByLabelText('Hard threshold (USD)')).toHaveValue(200);
  });

  it('renders the env-sync + Cost Explorer defer note', async () => {
    getMock.mockResolvedValue(null);
    render(<BudgetConfigEditor />);
    await waitFor(() => expect(screen.getByText(/env-sync step is deferred/i)).toBeInTheDocument());
    expect(screen.getByText(/#303/)).toBeInTheDocument();
  });

  it('creates on first save (exists=false)', async () => {
    getMock.mockResolvedValue(null);
    render(<BudgetConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Notification email')).toBeInTheDocument());
    // No row exists → email seeds blank; the admin must supply a recipient
    // before the form passes validation.
    fireEvent.change(screen.getByLabelText('Notification email'), {
      target: { value: 'ops@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]).toMatchObject({ exists: false });
  });

  it('updates when a row already exists (exists=true)', async () => {
    getMock.mockResolvedValue(row({ softUsd: 25 }));
    render(<BudgetConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Soft threshold (USD)')).toHaveValue(25));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]).toMatchObject({ exists: true });
  });

  it('blocks save and shows a field error when ordering is violated', async () => {
    getMock.mockResolvedValue(null);
    render(<BudgetConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Loud threshold (USD)')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Loud threshold (USD)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText('Loud must be greater than soft.')).toBeInTheDocument(),
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('blocks save and shows a field error on an invalid email', async () => {
    getMock.mockResolvedValue(row({ notificationEmail: 'nope' }));
    render(<BudgetConfigEditor />);
    await waitFor(() => expect(screen.getByLabelText('Notification email')).toHaveValue('nope'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText('Must be a valid email address.')).toBeInTheDocument(),
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('toggles a tier action and includes it in the saved payload', async () => {
    getMock.mockResolvedValue(row());
    render(<BudgetConfigEditor />);
    await waitFor(() =>
      expect(screen.getByLabelText('Hard tier — throttle Whisper concurrency')).toBeChecked(),
    );
    fireEvent.click(screen.getByLabelText('Hard tier — throttle Whisper concurrency'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[0]).toMatchObject({ hardThrottleEnabled: false });
  });
});
