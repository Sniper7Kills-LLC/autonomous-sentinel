import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageSubmitForm } from './MessageSubmitForm';

const submitMock = vi.fn();

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    mutations: {
      submitRecordingLessMessage: submitMock,
    },
  }),
}));

describe('MessageSubmitForm', () => {
  beforeEach(() => {
    submitMock.mockReset();
    submitMock.mockResolvedValue({
      data: { id: 'msg-new', publishedAt: '2026-05-27T12:30:00Z', flaggedForReview: true },
      errors: [],
    });
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

  it('rejects submission without a broadcast timestamp', async () => {
    render(<MessageSubmitForm />);
    fireEvent.click(screen.getByRole('button', { name: /submit message/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/timestamp is required/i);
    });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('submits non-empty fields and reports the live result', async () => {
    render(<MessageSubmitForm />);
    fireEvent.change(screen.getByLabelText(/broadcast timestamp/i), {
      target: { value: '2026-05-27T12:00' },
    });
    fireEvent.change(screen.getByLabelText(/sender/i), { target: { value: 'MAINSAIL' } });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'PT3 14 AB' } });
    fireEvent.click(screen.getByRole('button', { name: /submit message/i }));
    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    const args = submitMock.mock.calls[0]?.[0] as
      | { sender?: string; body?: string; broadcastTs: string }
      | undefined;
    expect(args?.sender).toBe('MAINSAIL');
    expect(args?.body).toBe('PT3 14 AB');
    expect(args?.broadcastTs).toMatch(/^2026-05-27T\d{2}:\d{2}/);
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/flagged for community review/i);
  });

  it('reports queued state when the server returns null publishedAt', async () => {
    submitMock.mockResolvedValueOnce({
      data: { id: 'msg-q', publishedAt: null, flaggedForReview: true },
      errors: [],
    });
    render(<MessageSubmitForm />);
    fireEvent.change(screen.getByLabelText(/broadcast timestamp/i), {
      target: { value: '2026-05-27T12:00' },
    });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: 'maybe' } });
    fireEvent.click(screen.getByRole('button', { name: /submit message/i }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/moderator queue/i);
  });
});
