import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProfileEditForm } from './ProfileEditForm';

interface MockProfile {
  displayName: string | null;
  preferredUsername: string | null;
  bio: string | null;
  avatarKey: string | null;
}

const getProfileMock = vi.fn<(sub: string) => Promise<MockProfile | null>>();
const updateMyProfileMock = vi.fn<(input: Record<string, unknown>) => Promise<void>>();
const resolveAvatarUrlMock = vi.fn<(key: string) => Promise<string | null>>();
vi.mock('@/lib/users/profile', () => ({
  getProfile: (sub: string) => getProfileMock(sub),
  updateMyProfile: (input: Record<string, unknown>) => updateMyProfileMock(input),
  resolveAvatarUrl: (key: string) => resolveAvatarUrlMock(key),
}));

vi.mock('@/components/auth/AuthProvider', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAuth: () => ({
    loading: false,
    signedIn: true,
    username: 'op',
    sub: 'sub-1',
    groups: ['member'],
  }),
}));

const uploadResultMock = vi.fn<() => Promise<{ path: string }>>();
vi.mock('aws-amplify/storage', () => ({
  uploadData: () => ({ result: uploadResultMock() }),
}));

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: () => Promise.resolve({ identityId: 'identity-9' }),
}));

describe('ProfileEditForm', () => {
  beforeEach(() => {
    getProfileMock.mockReset();
    updateMyProfileMock.mockReset();
    resolveAvatarUrlMock.mockReset();
    uploadResultMock.mockReset();
    updateMyProfileMock.mockResolvedValue(undefined);
    resolveAvatarUrlMock.mockResolvedValue('https://cdn.example/avatar.png');
  });

  it('pre-fills from getProfile and saves the edited values', async () => {
    getProfileMock.mockResolvedValue({
      displayName: 'Old Name',
      preferredUsername: 'oldhandle',
      bio: 'old bio',
      avatarKey: 'profile-photos/identity-9/avatar',
    });

    render(<ProfileEditForm sub="sub-1" />);

    // Pre-fill landed.
    const nameInput = await screen.findByLabelText<HTMLInputElement>('Display name');
    await waitFor(() => expect(nameInput.value).toBe('Old Name'));
    expect(screen.getByLabelText<HTMLInputElement>('Username').value).toBe('oldhandle');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Description').value).toBe('old bio');
    expect(getProfileMock).toHaveBeenCalledWith('sub-1');

    // Edit the fields.
    fireEvent.change(nameInput, { target: { value: 'New Name' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newhandle' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'new bio' } });

    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() =>
      expect(updateMyProfileMock).toHaveBeenCalledWith({
        displayName: 'New Name',
        preferredUsername: 'newhandle',
        bio: 'new bio',
        avatarKey: 'profile-photos/identity-9/avatar',
      }),
    );
    expect(await screen.findByText(/profile saved/i)).toBeInTheDocument();
  });

  it('uploads a picked avatar to S3 and persists the returned path on save', async () => {
    getProfileMock.mockResolvedValue({
      displayName: 'Op',
      preferredUsername: 'op',
      bio: '',
      avatarKey: null,
    });
    uploadResultMock.mockResolvedValue({ path: 'profile-photos/identity-9/avatar' });

    render(<ProfileEditForm sub="sub-1" />);
    await screen.findByLabelText('Display name');

    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    const fileInput = screen.getByLabelText('Avatar');
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(uploadResultMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() =>
      expect(updateMyProfileMock).toHaveBeenCalledWith(
        expect.objectContaining({ avatarKey: 'profile-photos/identity-9/avatar' }),
      ),
    );
  });
});
