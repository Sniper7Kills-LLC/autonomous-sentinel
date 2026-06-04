import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RecordingAdminControls } from './RecordingAdminControls';

const groupsMock = vi.fn<() => Promise<string[]>>();
vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchCallerGroups: (): Promise<string[]> => groupsMock(),
  };
});

const reprocessMock = vi.fn<(id: string, backend?: string) => Promise<void>>();
vi.mock('@/lib/uploads/reprocess', () => ({
  reprocessRecording: (id: string, backend?: string): Promise<void> => reprocessMock(id, backend),
}));

const reparseMock = vi.fn<(id: string) => Promise<void>>();
vi.mock('@/lib/uploads/reparse', () => ({
  reparseRecording: (id: string): Promise<void> => reparseMock(id),
}));

const softDeleteMock = vi.fn<(id: string, reason?: string) => Promise<void>>();
vi.mock('@/lib/messages/admin', () => ({
  softDeleteRecording: (id: string, reason?: string): Promise<void> => softDeleteMock(id, reason),
}));

describe('RecordingAdminControls (#566)', () => {
  beforeEach(() => {
    groupsMock.mockReset();
    reprocessMock.mockReset();
    reprocessMock.mockResolvedValue();
    reparseMock.mockReset();
    reparseMock.mockResolvedValue();
    softDeleteMock.mockReset();
    softDeleteMock.mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is hidden for a member session', async () => {
    groupsMock.mockResolvedValue(['member']);
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript />);
    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('recording-admin-controls')).not.toBeInTheDocument();
  });

  it('is hidden when the group lookup fails (guest / no session)', async () => {
    groupsMock.mockRejectedValue(new Error('no session'));
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript />);
    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('recording-admin-controls')).not.toBeInTheDocument();
  });

  it('shows both buttons for an admin', async () => {
    groupsMock.mockResolvedValue(['admin']);
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /re-transcribe \+ parse/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-parse transcript/i })).toBeInTheDocument();
  });

  it('shows both buttons for a moderator', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
  });

  it('invokes reprocessRecording and shows success feedback', async () => {
    groupsMock.mockResolvedValue(['admin']);

    render(<RecordingAdminControls recordingId="rec-7" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /re-transcribe \+ parse/i }));
    await waitFor(() => expect(screen.getByText(/full pipeline re-running/i)).toBeInTheDocument());
    // Defaults to whisper-local when the picker is untouched (#592).
    expect(reprocessMock).toHaveBeenCalledWith('rec-7', 'whisper-local');
    expect(reparseMock).not.toHaveBeenCalled();
  });

  it('passes the chosen backend to reprocessRecording (#592)', async () => {
    groupsMock.mockResolvedValue(['admin']);

    render(<RecordingAdminControls recordingId="rec-amz" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('reprocess-backend-select'), {
      target: { value: 'amazon-transcribe' },
    });
    fireEvent.click(screen.getByRole('button', { name: /re-transcribe \+ parse/i }));
    await waitFor(() => expect(reprocessMock).toHaveBeenCalled());
    expect(reprocessMock).toHaveBeenCalledWith('rec-amz', 'amazon-transcribe');
  });

  it('offers only the two built backends in the picker (#592)', async () => {
    groupsMock.mockResolvedValue(['admin']);
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    const select = screen.getByTestId('reprocess-backend-select');
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['whisper-local', 'amazon-transcribe']);
  });

  it('invokes reparseRecording and shows success feedback', async () => {
    groupsMock.mockResolvedValue(['moderator']);

    render(<RecordingAdminControls recordingId="rec-9" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /re-parse transcript/i }));
    await waitFor(() =>
      expect(screen.getByText(/AI re-running on the transcript/i)).toBeInTheDocument(),
    );
    expect(reparseMock).toHaveBeenCalledWith('rec-9');
    expect(reprocessMock).not.toHaveBeenCalled();
  });

  it('surfaces an error from the mutation', async () => {
    groupsMock.mockResolvedValue(['admin']);
    reparseMock.mockRejectedValue(new Error('reparseRecording failed: boom'));

    render(<RecordingAdminControls recordingId="rec-x" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /re-parse transcript/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/i));
  });

  it('disables Re-run AI when there is no stored transcript', async () => {
    groupsMock.mockResolvedValue(['admin']);
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript={false} />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /re-parse transcript/i })).toBeDisabled();
    // The full reprocess stays available — it works from stored audio.
    expect(screen.getByRole('button', { name: /re-transcribe \+ parse/i })).toBeEnabled();
  });

  it('hides Delete recording for a moderator (admin-only #721)', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    render(<RecordingAdminControls recordingId="rec-1" hasTranscript />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /delete recording/i })).not.toBeInTheDocument();
  });

  it('soft-deletes a recording after confirm and notifies the parent (#721)', async () => {
    groupsMock.mockResolvedValue(['admin']);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onDeleted = vi.fn();
    render(<RecordingAdminControls recordingId="rec-del" hasTranscript onDeleted={onDeleted} />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /delete recording/i }));
    await waitFor(() => expect(softDeleteMock).toHaveBeenCalledWith('rec-del', undefined));
    expect(onDeleted).toHaveBeenCalled();
  });

  it('does not soft-delete when the confirm is cancelled (#721)', async () => {
    groupsMock.mockResolvedValue(['admin']);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onDeleted = vi.fn();
    render(<RecordingAdminControls recordingId="rec-del" hasTranscript onDeleted={onDeleted} />);
    await waitFor(() => expect(screen.getByTestId('recording-admin-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /delete recording/i }));
    expect(softDeleteMock).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
