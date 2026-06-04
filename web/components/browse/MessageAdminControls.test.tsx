import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MessageAdminControls } from './MessageAdminControls';

const groupsMock = vi.fn<() => Promise<string[]>>();
vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchCallerGroups: (): Promise<string[]> => groupsMock(),
  };
});

const clearFlagMock = vi.fn<(id: string) => Promise<void>>();
vi.mock('@/lib/admin/moderation', () => ({
  clearMessageFlag: (id: string): Promise<void> => clearFlagMock(id),
}));

const softDeleteMock = vi.fn<(id: string, reason?: string) => Promise<void>>();
vi.mock('@/lib/messages/admin', () => ({
  softDeleteMessage: (id: string, reason?: string): Promise<void> => softDeleteMock(id, reason),
}));

describe('MessageAdminControls (#721)', () => {
  beforeEach(() => {
    groupsMock.mockReset();
    clearFlagMock.mockReset();
    clearFlagMock.mockResolvedValue();
    softDeleteMock.mockReset();
    softDeleteMock.mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is hidden for a member session', async () => {
    groupsMock.mockResolvedValue(['member']);
    render(<MessageAdminControls messageId="m1" flaggedForReview onChanged={vi.fn()} />);
    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('message-admin-controls')).not.toBeInTheDocument();
  });

  it('shows clear-flag for a moderator but not delete', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    render(<MessageAdminControls messageId="m1" flaggedForReview onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('message-admin-controls')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /clear review flag/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete message/i })).not.toBeInTheDocument();
  });

  it('hides clear-flag when the message is not flagged', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    render(<MessageAdminControls messageId="m1" flaggedForReview={false} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('message-admin-controls')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /clear review flag/i })).not.toBeInTheDocument();
  });

  it('clears the flag and notifies the parent', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    const onChanged = vi.fn();
    render(<MessageAdminControls messageId="m7" flaggedForReview onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('message-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /clear review flag/i }));
    await waitFor(() => expect(clearFlagMock).toHaveBeenCalledWith('m7'));
    expect(onChanged).toHaveBeenCalledWith('flag');
  });

  it('shows delete for an admin and soft-deletes after confirm', async () => {
    groupsMock.mockResolvedValue(['admin']);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChanged = vi.fn();
    render(<MessageAdminControls messageId="m9" flaggedForReview={false} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('message-admin-controls')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/delete reason/i), { target: { value: 'spam' } });
    fireEvent.click(screen.getByRole('button', { name: /delete message/i }));
    await waitFor(() => expect(softDeleteMock).toHaveBeenCalledWith('m9', 'spam'));
    expect(onChanged).toHaveBeenCalledWith('delete');
  });

  it('does not delete when the confirm is cancelled', async () => {
    groupsMock.mockResolvedValue(['admin']);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MessageAdminControls messageId="m9" flaggedForReview={false} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('message-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /delete message/i }));
    expect(softDeleteMock).not.toHaveBeenCalled();
  });

  it('surfaces a mutation error', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    clearFlagMock.mockRejectedValue(new Error('clearMessageFlag failed: boom'));
    render(<MessageAdminControls messageId="m1" flaggedForReview onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('message-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /clear review flag/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/i));
  });
});
