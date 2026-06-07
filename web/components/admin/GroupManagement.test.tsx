import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupManagement } from './GroupManagement';

// The component drives all I/O through the admin groups data layer; mock it
// so the test asserts on the UI flow, not the AppSync wire format.
const findUserSubByEmail = vi.fn<(email: string) => Promise<string | null>>();
const listUserGroups = vi.fn<(sub: string) => Promise<string[]>>();
const setUserGroup = vi.fn<(sub: string, group: string, action: string) => Promise<string[]>>();

vi.mock('@/lib/admin/groups', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findUserSubByEmail: (email: string) => findUserSubByEmail(email),
  listUserGroups: (sub: string) => listUserGroups(sub),
  setUserGroup: (sub: string, group: string, action: string) => setUserGroup(sub, group, action),
}));

describe('GroupManagement (#743)', () => {
  beforeEach(() => {
    findUserSubByEmail.mockReset();
    listUserGroups.mockReset();
    setUserGroup.mockReset();
  });

  async function lookup(email = 'target@example.com') {
    fireEvent.change(screen.getByLabelText(/user email to look up/i), {
      target: { value: email },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByTestId('group-editor')).toBeInTheDocument());
  }

  it('looks up a user by email and shows their current group membership', async () => {
    findUserSubByEmail.mockResolvedValue('sub-1');
    listUserGroups.mockResolvedValue(['member', 'diagnostics']);
    render(<GroupManagement />);
    await lookup();

    expect(findUserSubByEmail).toHaveBeenCalledWith('target@example.com');
    expect(listUserGroups).toHaveBeenCalledWith('sub-1');
    // member + diagnostics show the "member" badge; admin/moderator do not.
    expect(screen.getByTestId('member-member')).toBeInTheDocument();
    expect(screen.getByTestId('member-diagnostics')).toBeInTheDocument();
    expect(screen.queryByTestId('member-admin')).not.toBeInTheDocument();
  });

  it('shows an error when no user matches the email', async () => {
    findUserSubByEmail.mockResolvedValue(null);
    render(<GroupManagement />);
    fireEvent.change(screen.getByLabelText(/user email to look up/i), {
      target: { value: 'nobody@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no user found/i));
    expect(listUserGroups).not.toHaveBeenCalled();
  });

  it('adds a group the user is not in', async () => {
    findUserSubByEmail.mockResolvedValue('sub-1');
    listUserGroups.mockResolvedValue(['member']);
    setUserGroup.mockResolvedValue(['member', 'diagnostics']);
    render(<GroupManagement />);
    await lookup();

    // diagnostics not yet a member → its row offers "Add".
    const addButtons = screen.getAllByRole('button', { name: /^add$/i });
    const diagAdd = addButtons.find((b) =>
      b.closest('li')?.textContent?.toLowerCase().includes('diagnostics'),
    );
    expect(diagAdd).toBeDefined();
    fireEvent.click(diagAdd as HTMLElement);

    await waitFor(() => expect(setUserGroup).toHaveBeenCalledWith('sub-1', 'diagnostics', 'add'));
    await waitFor(() => expect(screen.getByTestId('member-diagnostics')).toBeInTheDocument());
  });

  it('removes a group the user is in', async () => {
    findUserSubByEmail.mockResolvedValue('sub-1');
    listUserGroups.mockResolvedValue(['member', 'diagnostics']);
    setUserGroup.mockResolvedValue(['member']);
    render(<GroupManagement />);
    await lookup();

    const removeButtons = screen.getAllByRole('button', { name: /^remove$/i });
    const diagRemove = removeButtons.find((b) =>
      b.closest('li')?.textContent?.toLowerCase().includes('diagnostics'),
    );
    fireEvent.click(diagRemove as HTMLElement);

    await waitFor(() =>
      expect(setUserGroup).toHaveBeenCalledWith('sub-1', 'diagnostics', 'remove'),
    );
    await waitFor(() => expect(screen.queryByTestId('member-diagnostics')).not.toBeInTheDocument());
  });

  it('surfaces an error if the group update fails', async () => {
    findUserSubByEmail.mockResolvedValue('sub-1');
    listUserGroups.mockResolvedValue(['member']);
    setUserGroup.mockRejectedValue(new Error('boom'));
    render(<GroupManagement />);
    await lookup();

    const addButtons = screen.getAllByRole('button', { name: /^add$/i });
    fireEvent.click(addButtons[0] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/i));
  });
});
