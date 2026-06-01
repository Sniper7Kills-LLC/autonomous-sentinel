import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LinguisticThresholdsEditor } from './LinguisticThresholdsEditor';
import { MESSAGE_TYPES } from '@/lib/messages/filters';

const getMock = vi.fn<(key: string) => Promise<unknown>>();
const upsertMock = vi.fn<(key: string, value: unknown, notes?: string | null) => Promise<void>>();

vi.mock('@/lib/admin/linguistic', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getLinguisticConfig: (key: string): Promise<unknown> => getMock(key),
    upsertLinguisticConfig: (key: string, value: unknown, notes?: string | null): Promise<void> =>
      upsertMock(key, value, notes),
  };
});

beforeEach(() => {
  getMock.mockReset();
  upsertMock.mockReset();
  getMock.mockResolvedValue(undefined);
  upsertMock.mockResolvedValue(undefined);
});

describe('LinguisticThresholdsEditor', () => {
  it('renders one row per message type defaulting to 0.8', async () => {
    render(<LinguisticThresholdsEditor />);
    await waitFor(() => expect(screen.getByTestId('thresholds-list')).toBeInTheDocument());
    for (const type of MESSAGE_TYPES) {
      const input = screen.getByTestId(`threshold-input-${type}`);
      expect(input).toHaveValue(0.8);
    }
  });

  it('seeds saved values from the loaded config', async () => {
    getMock.mockResolvedValue({ SKYKING: 0.95 });
    render(<LinguisticThresholdsEditor />);
    await waitFor(() => expect(screen.getByTestId('thresholds-list')).toBeInTheDocument());
    const input = screen.getByTestId('threshold-input-SKYKING');
    expect(input).toHaveValue(0.95);
  });

  it('edits a value and saves the full clamped map via upsert', async () => {
    render(<LinguisticThresholdsEditor />);
    await waitFor(() => expect(screen.getByTestId('thresholds-list')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('threshold-input-SKYKING'), { target: { value: '0.6' } });
    fireEvent.click(screen.getByText('Save thresholds'));
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    const [key, value] = upsertMock.mock.calls[0]! as [string, Record<string, number>];
    expect(key).toBe('thresholds');
    expect(value.SKYKING).toBe(0.6);
    expect(value.OTHER).toBe(0.8);
  });

  it('clamps an out-of-range numeric entry before saving', async () => {
    render(<LinguisticThresholdsEditor />);
    await waitFor(() => expect(screen.getByTestId('thresholds-list')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('threshold-input-OTHER'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Save thresholds'));
    await waitFor(() => expect(upsertMock).toHaveBeenCalled());
    const [, value] = upsertMock.mock.calls[0]! as [string, Record<string, number>];
    expect(value.OTHER).toBe(1);
  });

  it('surfaces a save error', async () => {
    upsertMock.mockRejectedValue(new Error('Unauthorized'));
    render(<LinguisticThresholdsEditor />);
    await waitFor(() => expect(screen.getByTestId('thresholds-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Save thresholds'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unauthorized'));
  });
});
