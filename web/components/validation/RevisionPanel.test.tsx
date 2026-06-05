import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RevisionPanel } from './RevisionPanel';

const listMock = vi.fn<() => Promise<unknown>>();
const submitMock = vi.fn<(recordingId: string, proposedText: string) => Promise<unknown>>();
const castMock = vi.fn<(revisionId: string, value: string) => Promise<unknown>>();
const acceptMock = vi.fn<(revisionId: string) => Promise<unknown>>();

vi.mock('@/lib/revisions/query', () => ({
  listRevisionsForRecording: (): Promise<unknown> => listMock(),
  submitTranscriptRevision: (recordingId: string, proposedText: string): Promise<unknown> =>
    submitMock(recordingId, proposedText),
  castRevisionVote: (revisionId: string, value: string): Promise<unknown> =>
    castMock(revisionId, value),
  acceptTranscriptRevision: (revisionId: string): Promise<unknown> => acceptMock(revisionId),
}));

const groupsMock = vi.fn<() => string[]>(() => []);
vi.mock('@/components/auth/AuthProvider', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCallerGroups: () => ({ groups: groupsMock(), loading: false }),
}));

// UserNameLink (revision proposer) resolves the sub via getUserLabel. Stub it so
// the render is synchronous and no dynamic-import promise dangles past teardown.
vi.mock('@/lib/users/label', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getUserLabel: (sub: string) => Promise.resolve({ sub, label: sub, piiBlanked: false }),
}));

const baseRow = {
  id: 'rev-1',
  recordingId: 'rec-1',
  proposedText: 'SKYKING PT3 14 AB',
  proposedBy: 'voter-sub',
  source: 'MANUAL' as const,
  voteScore: 2,
  accepted: false,
  acceptedAt: null,
  superseded: false,
  createdAt: '2026-05-27T12:00:00Z',
};

describe('RevisionPanel', () => {
  beforeEach(() => {
    listMock.mockReset();
    submitMock.mockReset();
    castMock.mockReset();
    acceptMock.mockReset();
    acceptMock.mockResolvedValue({ ...baseRow, accepted: true });
    groupsMock.mockReset();
    groupsMock.mockReturnValue([]);
    listMock.mockResolvedValue([baseRow]);
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

  it('lists revisions returned by the data client', async () => {
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={false} />);
    await waitFor(() => {
      expect(screen.getByText('SKYKING PT3 14 AB')).toBeInTheDocument();
    });
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides the submit form when transcription succeeded', async () => {
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={true} />);
    await waitFor(() => {
      expect(screen.getByText('SKYKING PT3 14 AB')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/proposed transcript/i)).toBeNull();
  });

  it('shows the submit form when transcription failed AND signed in', async () => {
    listMock.mockResolvedValue([]);
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={true} signedIn={true} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/proposed transcript/i)).toBeInTheDocument();
    });
  });

  it('hides the submit form when transcription failed but signed out', async () => {
    listMock.mockResolvedValue([]);
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={true} signedIn={false} />);
    await waitFor(() => {
      expect(screen.queryByLabelText(/proposed transcript/i)).toBeNull();
    });
  });

  it('rejects empty submission with an inline error', async () => {
    listMock.mockResolvedValue([]);
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={true} signedIn={true} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/proposed transcript/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /submit transcript/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/before submitting/i);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('submits proposed transcript + reloads list on success', async () => {
    listMock.mockResolvedValueOnce([]);
    submitMock.mockResolvedValueOnce({
      ...baseRow,
      id: 'rev-2',
      proposedText: 'NEW PROPOSAL',
    });
    listMock.mockResolvedValueOnce([{ ...baseRow, id: 'rev-2', proposedText: 'NEW PROPOSAL' }]);
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={true} signedIn={true} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/proposed transcript/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/proposed transcript/i), {
      target: { value: 'NEW PROPOSAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit transcript/i }));
    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith('rec-1', 'NEW PROPOSAL');
    });
    await waitFor(() => {
      expect(screen.getByText('NEW PROPOSAL')).toBeInTheDocument();
    });
  });

  it('disables vote buttons for signed-out visitors', async () => {
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={false} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /vote up/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /vote down/i })).toBeDisabled();
    });
  });

  it('casts a vote when an authenticated user clicks UP', async () => {
    castMock.mockResolvedValue(undefined);
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={true} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /vote up/i })).not.toBeDisabled();
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /vote up/i }));
    });
    await waitFor(() => {
      expect(castMock).toHaveBeenCalledWith('rev-1', 'UP');
    });
  });

  it('surfaces vote errors via the alert region', async () => {
    castMock.mockRejectedValueOnce(new Error('rate limited'));
    render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={true} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /vote down/i })).not.toBeDisabled();
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /vote down/i }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/rate limited/i);
  });

  describe('accept revision (#654)', () => {
    it('hides Accept for a member', async () => {
      groupsMock.mockReturnValue(['member']);
      render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={true} />);
      await waitFor(() => expect(screen.getByText('SKYKING PT3 14 AB')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    });

    it('hides Accept for signed-out visitors', async () => {
      render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={false} />);
      await waitFor(() => expect(screen.getByText('SKYKING PT3 14 AB')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    });

    it('shows Accept for a moderator on a live revision and accepts on click', async () => {
      groupsMock.mockReturnValue(['moderator']);
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      acceptMock.mockResolvedValueOnce({ ...baseRow, accepted: true });
      listMock.mockResolvedValueOnce([baseRow]); // initial
      listMock.mockResolvedValueOnce([{ ...baseRow, accepted: true }]); // post-accept refresh
      render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={true} />);

      const acceptBtn = await screen.findByRole('button', { name: /accept/i });
      act(() => {
        fireEvent.click(acceptBtn);
      });
      await waitFor(() => expect(acceptMock).toHaveBeenCalledWith('rev-1'));
    });

    it('does not show Accept on an already-accepted revision', async () => {
      groupsMock.mockReturnValue(['admin']);
      listMock.mockResolvedValue([{ ...baseRow, accepted: true }]);
      render(<RevisionPanel recordingId="rec-1" transcriptionFailed={false} signedIn={true} />);
      await waitFor(() => expect(screen.getByText('ACCEPTED')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull();
    });
  });

  describe('inline correction form (#93)', () => {
    const TRANSCRIPT = 'SKYKING SKYKING DO NOT ANSWER PT3 14 AB';

    function openForm() {
      fireEvent.click(screen.getByRole('button', { name: /suggest a correction/i }));
    }

    it('offers a correction button for a successful transcript when signed in', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
    });

    it('shows a sign-in prompt instead of the form when signed out', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={false}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /suggest a correction/i })).toBeNull();
    });

    it('offers no correction affordance when there is no transcript', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={null}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('SKYKING PT3 14 AB')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /suggest a correction/i })).toBeNull();
    });

    it('opens the editor pre-filled with the current transcript and shows a diff', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      const editor = screen.getByLabelText(/your correction/i);
      expect((editor as HTMLTextAreaElement).value).toBe(TRANSCRIPT);
      fireEvent.change(editor, { target: { value: TRANSCRIPT.replace('14', '15') } });
      await waitFor(() => {
        expect(screen.getByLabelText(/diff of your changes/i)).toBeInTheDocument();
      });
    });

    it('rejects an unchanged submission', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      fireEvent.click(screen.getByRole('button', { name: /submit correction/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/matches the current/i);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('blocks submission on a client-side profanity hit', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      fireEvent.change(screen.getByLabelText(/your correction/i), {
        target: { value: 'this is fucking wrong' },
      });
      fireEvent.click(screen.getByRole('button', { name: /submit correction/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/language filter/i);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('rejects text longer than 1.5x the current transcript', async () => {
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript="SHORT"
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      fireEvent.change(screen.getByLabelText(/your correction/i), {
        target: { value: 'WAY TOO LONG FOR FIVE CHARS' },
      });
      fireEvent.click(screen.getByRole('button', { name: /submit correction/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/max \d+ characters/i);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('submits a correction and shows the success state', async () => {
      submitMock.mockResolvedValueOnce({ ...baseRow, id: 'rev-9' });
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      const corrected = TRANSCRIPT.replace('14', '15');
      fireEvent.change(screen.getByLabelText(/your correction/i), {
        target: { value: corrected },
      });
      fireEvent.click(screen.getByRole('button', { name: /submit correction/i }));
      await waitFor(() => {
        expect(submitMock).toHaveBeenCalledWith('rec-1', corrected);
      });
      expect(await screen.findByRole('status')).toHaveTextContent(/up for community vote/i);
    });

    it('surfaces a friendly retry message on a rate-limit error', async () => {
      submitMock.mockRejectedValueOnce(new Error('RateLimitExceeded: too many requests'));
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      fireEvent.change(screen.getByLabelText(/your correction/i), {
        target: { value: TRANSCRIPT.replace('14', '16') },
      });
      fireEvent.click(screen.getByRole('button', { name: /submit correction/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/rate limit/i);
    });

    it('confirms before discarding a dirty draft on cancel', async () => {
      const confirmSpy = vi.fn().mockReturnValue(false);
      vi.stubGlobal('confirm', confirmSpy);
      render(
        <RevisionPanel
          recordingId="rec-1"
          transcriptionFailed={false}
          signedIn={true}
          transcript={TRANSCRIPT}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /suggest a correction/i })).toBeInTheDocument();
      });
      openForm();
      fireEvent.change(screen.getByLabelText(/your correction/i), {
        target: { value: TRANSCRIPT.replace('14', '17') },
      });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(confirmSpy).toHaveBeenCalled();
      // confirm returned false → editor stays open
      expect(screen.getByLabelText(/your correction/i)).toBeInTheDocument();
    });
  });
});
