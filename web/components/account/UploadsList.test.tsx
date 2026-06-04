import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { UploadsList } from './UploadsList';

const listMock = vi.fn<() => Promise<unknown>>();
vi.mock('@/lib/uploads/query', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listMyUploads: (): Promise<unknown> => listMock(),
  };
});

const groupsMock = vi.fn<() => string[]>(() => []);
vi.mock('@/components/auth/AuthProvider', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCallerGroups: () => ({ groups: groupsMock(), loading: false }),
}));

const reprocessMock = vi.fn<(id: string) => Promise<void>>();
vi.mock('@/lib/uploads/reprocess', () => ({
  reprocessRecording: (id: string): Promise<void> => reprocessMock(id),
}));

const failedRow = {
  id: 'rec-ccc',
  messageId: null,
  contentHash: 'h',
  originalKey: 'recordings/originals/h.wav',
  webCanonicalKey: null,
  wordTimestampsKey: null,
  peaksJsonKey: null,
  transcript: null,
  transcriptionStatus: 'TRANSCRIBE_FAILED',
  transcriptionStatusUpdatedAt: '2026-05-28T19:00:00Z',
  transcriptionFailed: true,
  failedReason: 'whisper.cpp exit 1',
  frequencyKhz: null,
  modulation: null,
  broadcastedAt: null,
  durationMs: null,
  sdrId: null,
  automated: false,
  createdAt: '2026-05-28T19:00:00Z',
};

describe('UploadsList', () => {
  beforeEach(() => {
    listMock.mockReset();
    groupsMock.mockReset();
    groupsMock.mockReturnValue([]);
    reprocessMock.mockReset();
    reprocessMock.mockResolvedValue(undefined);
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

  it('shows the empty state when the caller has no uploads', async () => {
    listMock.mockResolvedValue({ items: [], nextToken: null });
    render(<UploadsList uploaderId="sub-1" />);
    await waitFor(() => {
      expect(screen.getByText(/no uploads yet/i)).toBeInTheDocument();
    });
  });

  it('renders one row per Recording with the published pill', async () => {
    listMock.mockResolvedValue({
      items: [
        {
          id: 'rec-aaa',
          messageId: 'msg-1',
          contentHash: 'h',
          originalKey: null,
          webCanonicalKey: null,
          wordTimestampsKey: null,
          peaksJsonKey: null,
          transcript: null,
          transcriptionStatus: 'PUBLISHED',
          transcriptionStatusUpdatedAt: '2026-05-28T19:00:00Z',
          transcriptionFailed: false,
          failedReason: null,
          frequencyKhz: 11175,
          modulation: 'USB',
          broadcastedAt: '2026-05-28T18:59:00Z',
          durationMs: 4200,
          sdrId: null,
          automated: true,
          createdAt: '2026-05-28T19:00:00Z',
        },
      ],
      nextToken: null,
    });
    render(<UploadsList uploaderId="sub-1" />);
    await waitFor(() => {
      expect(screen.getByText('Published')).toBeInTheDocument();
    });
    expect(screen.getByText(/11\.175 MHz · USB/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open message/i })).toBeInTheDocument();
  });

  it('surfaces failure reason inline for failed rows', async () => {
    listMock.mockResolvedValue({
      items: [
        {
          id: 'rec-bbb',
          messageId: null,
          contentHash: 'h',
          originalKey: null,
          webCanonicalKey: null,
          wordTimestampsKey: null,
          peaksJsonKey: null,
          transcript: null,
          transcriptionStatus: 'TRANSCRIBE_FAILED',
          transcriptionStatusUpdatedAt: '2026-05-28T19:00:00Z',
          transcriptionFailed: true,
          failedReason: 'whisper.cpp exit 1',
          frequencyKhz: null,
          modulation: null,
          broadcastedAt: null,
          durationMs: null,
          sdrId: null,
          automated: false,
          createdAt: '2026-05-28T19:00:00Z',
        },
      ],
      nextToken: null,
    });
    render(<UploadsList uploaderId="sub-1" />);
    expect(await screen.findByText('whisper.cpp exit 1')).toBeInTheDocument();
    expect(screen.getByText(/transcribe failed/i)).toBeInTheDocument();
  });

  it('renders an error banner when the query rejects', async () => {
    listMock.mockRejectedValue(new Error('Unauthorized'));
    render(<UploadsList uploaderId="sub-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unauthorized/i);
  });

  it('hides the Reprocess button for a non-mod/admin member (#505)', async () => {
    groupsMock.mockReturnValue(['member']);
    listMock.mockResolvedValue({ items: [failedRow], nextToken: null });
    render(<UploadsList uploaderId="sub-1" />);
    await waitFor(() => expect(screen.getByText('whisper.cpp exit 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /reprocess/i })).not.toBeInTheDocument();
  });

  it('shows Reprocess for a moderator/admin and calls the mutation, flipping the row to queued (#505)', async () => {
    groupsMock.mockReturnValue(['admin']);
    listMock.mockResolvedValue({ items: [failedRow], nextToken: null });
    render(<UploadsList uploaderId="sub-1" />);

    const btn = await screen.findByRole('button', { name: /reprocess/i });
    fireEvent.click(btn);

    await waitFor(() => expect(reprocessMock).toHaveBeenCalledWith('rec-ccc'));
    // Optimistic status flip — pill moves to Queued, failure text clears.
    await waitFor(() => expect(screen.getByText('Queued')).toBeInTheDocument());
    expect(screen.queryByText('whisper.cpp exit 1')).not.toBeInTheDocument();
  });

  it('hides Reprocess for a recording-less row (no originalKey) even for admins (#505)', async () => {
    groupsMock.mockReturnValue(['admin']);
    listMock.mockResolvedValue({
      items: [{ ...failedRow, originalKey: null }],
      nextToken: null,
    });
    render(<UploadsList uploaderId="sub-1" />);
    await waitFor(() => expect(screen.getByText('whisper.cpp exit 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /reprocess/i })).not.toBeInTheDocument();
  });
});
