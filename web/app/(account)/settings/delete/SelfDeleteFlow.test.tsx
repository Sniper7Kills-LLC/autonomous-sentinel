import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SelfDeleteFlow } from './SelfDeleteFlow';

const selfDeleteMock = vi.fn<() => Promise<unknown>>();
vi.mock('@/lib/account/selfDelete', () => ({
  selfDelete: () => selfDeleteMock(),
}));

describe('SelfDeleteFlow', () => {
  beforeEach(() => {
    selfDeleteMock.mockReset();
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

  it('starts on the review stage with the username in scope', () => {
    render(<SelfDeleteFlow username="member@example.com" />);
    expect(screen.getByText(/member@example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /i understand — continue/i })).toBeInTheDocument();
  });

  it('advances to the confirm stage on click', () => {
    render(<SelfDeleteFlow username="m" />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByLabelText(/type delete my account to confirm/i)).toBeInTheDocument();
  });

  it('rejects submission when the phrase is wrong', () => {
    render(<SelfDeleteFlow username="m" />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getByLabelText(/type delete my account to confirm/i), {
      target: { value: 'wrong' },
    });
    expect(screen.getByRole('button', { name: /delete my account/i })).toBeDisabled();
    expect(selfDeleteMock).not.toHaveBeenCalled();
  });

  it('calls selfDelete + shows the done state on correct phrase', async () => {
    selfDeleteMock.mockResolvedValue({ id: 'u-1', piiBlanked: true, piiBlankedAt: 'now' });
    render(<SelfDeleteFlow username="m" />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getByLabelText(/type delete my account to confirm/i), {
      target: { value: 'DELETE MY ACCOUNT' },
    });
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    await waitFor(() => {
      expect(selfDeleteMock).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/your account has been blanked/i)).toBeInTheDocument();
  });

  it('shows mutation error inline', async () => {
    selfDeleteMock.mockRejectedValue(new Error('Unauthorized'));
    render(<SelfDeleteFlow username="m" />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getByLabelText(/type delete my account to confirm/i), {
      target: { value: 'DELETE MY ACCOUNT' },
    });
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unauthorized/i);
  });
});
