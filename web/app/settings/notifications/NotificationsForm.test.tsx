import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationsForm } from './NotificationsForm';

const getMock = vi.fn<() => Promise<unknown>>();
const setMock = vi.fn<(patch: Record<string, unknown>) => Promise<unknown>>();

vi.mock('@/lib/notifications/query', () => ({
  getMyNotificationPreference: () => getMock(),
  setNotificationPreference: (patch: Record<string, unknown>) => setMock(patch),
}));

const basePref = {
  userId: 'sub-1',
  emailEnabled: false,
  pushEnabled: false,
  discordWebhookEnabled: false,
  discordWebhookUrl: null,
  subscribedTypes: [],
  weeklyDigest: false,
};

describe('NotificationsForm', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
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

  it('renders channel toggles + every MESSAGE_TYPE chip', async () => {
    getMock.mockResolvedValue(basePref);
    render(<NotificationsForm />);
    expect(await screen.findByRole('checkbox', { name: /^email/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /web push/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /^discord webhook$/i })).toBeInTheDocument();
    expect(screen.getByText('SKYKING')).toBeInTheDocument();
    expect(screen.getByText('BACKEND')).toBeInTheDocument();
  });

  it('reveals the webhook URL input when Discord toggle is on', async () => {
    getMock.mockResolvedValue({ ...basePref, discordWebhookEnabled: true });
    render(<NotificationsForm />);
    expect(await screen.findByLabelText(/Discord webhook URL/i)).toBeInTheDocument();
  });

  it('calls setNotificationPreference with the current edits + shows saved indicator', async () => {
    getMock.mockResolvedValue(basePref);
    setMock.mockResolvedValue({ ...basePref, emailEnabled: true });
    render(<NotificationsForm />);
    const emailToggle = await screen.findByRole('checkbox', { name: /^email/i });
    fireEvent.click(emailToggle);
    fireEvent.click(screen.getByRole('button', { name: /save preferences/i }));
    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ emailEnabled: true }));
    });
    expect(await screen.findByText(/Saved at/i)).toBeInTheDocument();
  });

  it('shows error banner when fetch fails', async () => {
    getMock.mockRejectedValue(new Error('Unauthorized'));
    render(<NotificationsForm />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unauthorized/i);
  });
});
