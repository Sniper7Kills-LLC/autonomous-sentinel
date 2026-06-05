import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CommentsSection } from './CommentsSection';
import type { DisplayComment } from '@/lib/comments/query';

const listMock = vi.fn<(messageId: string) => Promise<DisplayComment[]>>();
const submitMock = vi.fn<(m: string, b: string, p?: string | null) => Promise<DisplayComment>>();
const editMock = vi.fn<(id: string, b: string) => Promise<DisplayComment>>();
const deleteMock = vi.fn<(id: string) => Promise<DisplayComment>>();
const hideMock = vi.fn<(id: string, h: boolean) => Promise<DisplayComment>>();

vi.mock('@/lib/comments/query', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listComments: (m: string) => listMock(m),
    submitComment: (m: string, b: string, p?: string | null) => submitMock(m, b, p),
    editOwnComment: (id: string, b: string) => editMock(id, b),
    softDeleteComment: (id: string) => deleteMock(id),
    setCommentHidden: (id: string, h: boolean) => hideMock(id, h),
  };
});

const groupsMock = vi.fn<() => string[]>(() => []);
vi.mock('@/components/auth/AuthProvider', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCallerGroups: () => ({ groups: groupsMock(), loading: false }),
}));

interface MockSession {
  loading: boolean;
  signedIn: boolean;
  username: string | null;
  sub: string | null;
}
const sessionMock = vi.fn<() => MockSession>();
vi.mock('@/components/account/SessionGreeting', () => ({
  useSessionState: (): MockSession => sessionMock(),
}));

// UserNameLink (comment author) resolves the sub via getUserLabel. Stub it so
// the render is synchronous and no dynamic-import promise dangles past teardown.
vi.mock('@/lib/users/label', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getUserLabel: (sub: string) => Promise.resolve({ sub, label: sub, piiBlanked: false }),
}));

// AbuseReportButton pulls amplify config in; stub to a simple button.
vi.mock('@/components/abuse/AbuseReportButton', () => ({
  AbuseReportButton: ({ targetType, targetId }: { targetType: string; targetId: string }) => (
    <button type="button" data-testid={`flag-${targetId}`}>
      Flag {targetType}
    </button>
  ),
}));

function comment(partial: Partial<DisplayComment>): DisplayComment {
  return {
    id: 'c',
    messageId: 'm1',
    parentCommentId: null,
    depth: 0,
    body: 'hello world',
    authorId: 'author-aaaa',
    flagged: false,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ...partial,
  };
}

const signedIn = { loading: false, signedIn: true, username: 'me', sub: 'author-aaaa' };
const signedOut = { loading: false, signedIn: false, username: null, sub: null };
const otherUser = { loading: false, signedIn: true, username: 'other', sub: 'someone-else' };

describe('CommentsSection (#98)', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    submitMock.mockReset().mockResolvedValue(comment({ id: 'new' }));
    editMock.mockReset().mockResolvedValue(comment({ id: 'c1' }));
    deleteMock
      .mockReset()
      .mockResolvedValue(comment({ id: 'c1', deletedAt: new Date().toISOString() }));
    hideMock.mockReset().mockResolvedValue(comment({ id: 'c1', flagged: true }));
    groupsMock.mockReset().mockReturnValue([]);
    sessionMock.mockReset().mockReturnValue(signedIn);
  });

  it('shows empty state when there are no comments', async () => {
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText(/be the first to comment/i)).toBeInTheDocument());
  });

  it('prompts sign-in for signed-out visitors and shows no composer', async () => {
    sessionMock.mockReturnValue(signedOut);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText(/sign in to join/i)).toBeInTheDocument());
    expect(screen.queryByPlaceholderText(/add to the discussion/i)).not.toBeInTheDocument();
  });

  it('posts a top-level comment', async () => {
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText(/be the first/i)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/add to the discussion/i), {
      target: { value: 'first post' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('m1', 'first post', null));
  });

  it('renders a deleted comment as a placeholder preserving the slot', async () => {
    listMock.mockResolvedValue([
      comment({ id: 'c1', deletedAt: new Date().toISOString(), body: '[removed]' }),
    ]);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText(/\[comment deleted\]/i)).toBeInTheDocument());
  });

  it('shows the moderator-hidden placeholder to a non-mod, non-owner viewer', async () => {
    sessionMock.mockReturnValue(otherUser);
    listMock.mockResolvedValue([comment({ id: 'c1', flagged: true, authorId: 'author-aaaa' })]);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() =>
      expect(screen.getByText(/comment hidden by a moderator/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('hello world')).not.toBeInTheDocument();
  });

  it('lets a moderator see hidden content + a hide toggle', async () => {
    sessionMock.mockReturnValue(otherUser);
    groupsMock.mockReturnValue(['moderator']);
    listMock.mockResolvedValue([comment({ id: 'c1', flagged: true })]);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeInTheDocument());
    const unhide = await screen.findByRole('button', { name: /unhide/i });
    fireEvent.click(unhide);
    await waitFor(() => expect(hideMock).toHaveBeenCalledWith('c1', false));
  });

  it('lets the author edit within the edit window', async () => {
    listMock.mockResolvedValue([comment({ id: 'c1', authorId: 'author-aaaa' })]);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const ta = screen.getByLabelText(/edit comment/i);
    fireEvent.change(ta, { target: { value: 'edited body' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(editMock).toHaveBeenCalledWith('c1', 'edited body'));
  });

  it('hides the edit button after the 5-minute window', async () => {
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    listMock.mockResolvedValue([comment({ id: 'c1', authorId: 'author-aaaa', createdAt: old })]);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    // Delete is still available to the owner.
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('replies under a comment passing its id as parent', async () => {
    sessionMock.mockReturnValue(otherUser);
    listMock.mockResolvedValue([comment({ id: 'c1', authorId: 'author-aaaa' })]);
    render(<CommentsSection messageId="m1" />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));
    fireEvent.change(screen.getByLabelText(/reply to comment/i), {
      target: { value: 'my reply' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post reply/i }));
    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('m1', 'my reply', 'c1'));
  });
});
