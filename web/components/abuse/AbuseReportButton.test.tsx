import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AbuseReportButton } from './AbuseReportButton';

const submitMock = vi.fn<(input: unknown) => Promise<string>>();
vi.mock('@/lib/abuse/query', () => ({
  submitAbuseReport: (input: unknown) => submitMock(input),
}));

describe('AbuseReportButton', () => {
  beforeEach(() => {
    submitMock.mockReset();
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
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing for guest visitors', () => {
    const { container } = render(
      <AbuseReportButton targetType="MESSAGE" targetId="m-1" reporterId={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the trigger button for signed-in callers', () => {
    render(<AbuseReportButton targetType="MESSAGE" targetId="m-1" reporterId="r-1" />);
    expect(screen.getByRole('button', { name: /report/i })).toBeInTheDocument();
  });

  it('opens the popover on click + posts a report on submit', async () => {
    submitMock.mockResolvedValue('abuse-1');
    render(<AbuseReportButton targetType="MESSAGE" targetId="m-1" reporterId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: /^report$/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'OFFENSIVE' } });
    fireEvent.change(screen.getByLabelText(/notes/i), {
      target: { value: 'hate speech' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith({
        targetType: 'MESSAGE',
        targetId: 'm-1',
        reporterId: 'r-1',
        reason: 'OFFENSIVE',
        notes: 'hate speech',
      });
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/thanks/i);
  });

  it('surfaces submission errors via the alert region', async () => {
    submitMock.mockRejectedValue(new Error('Unauthorized'));
    render(<AbuseReportButton targetType="MESSAGE" targetId="m-1" reporterId="r-1" />);
    fireEvent.click(screen.getByRole('button', { name: /^report$/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unauthorized/i);
  });
});
