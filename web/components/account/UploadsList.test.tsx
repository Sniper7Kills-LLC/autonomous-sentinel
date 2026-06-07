import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { UploadsList } from './UploadsList';
import type { UploadRow } from '@/lib/uploads/query';

// observeMyUploads is mocked to capture the handlers so a test can drive
// `next(rows)` / `error(err)` like a live AppSync observeQuery snapshot.
type Handlers = { next: (rows: UploadRow[]) => void; error?: (err: unknown) => void };
let captured: Handlers | null = null;
const unsubscribeMock = vi.fn();
const observeMock = vi.fn((_uploaderId: string, handlers: Handlers) => {
  captured = handlers;
  return { unsubscribe: unsubscribeMock };
});
// Initial one-shot list (reliable first paint). Default: empty.
const listMock = vi.fn<() => Promise<{ items: UploadRow[]; nextToken: string | null }>>();
vi.mock('@/lib/uploads/query', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listMyUploads: () => listMock(),
    observeMyUploads: (uploaderId: string, handlers: Handlers) => observeMock(uploaderId, handlers),
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

/** Build an UploadRow-shaped fixture (observeMyUploads is mocked, so the
 *  component receives these directly — no toUploadRow mapping). */
function row(p: Partial<UploadRow> = {}): UploadRow {
  return {
    id: 'rec-ccc',
    messageId: null,
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
    webCanonicalKey: null,
    wordTimestampsKey: null,
    peaksJsonKey: null,
    transcriptionConfidence: null,
    uploaderId: 'sub-1',
    createdAt: '2026-05-28T19:00:00Z',
    originalKey: 'recordings/originals/h.wav',
    ...p,
  } as UploadRow;
}

/** Deliver a live snapshot through the captured subscription handler. */
function emit(rows: UploadRow[]): void {
  act(() => captured?.next(rows));
}

describe('UploadsList (#774 live)', () => {
  beforeEach(() => {
    captured = null;
    observeMock.mockClear();
    unsubscribeMock.mockClear();
    listMock.mockReset();
    listMock.mockResolvedValue({ items: [], nextToken: null });
    groupsMock.mockReset();
    groupsMock.mockReturnValue([]);
    reprocessMock.mockReset();
    reprocessMock.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the empty state when the caller has no uploads', async () => {
    render(<UploadsList uploaderId="sub-1" />);
    emit([]);
    await waitFor(() => expect(screen.getByText(/no uploads yet/i)).toBeInTheDocument());
  });

  it('renders a row with status pill, upload + broadcast time, and message link', async () => {
    render(<UploadsList uploaderId="sub-1" />);
    emit([
      row({
        id: 'rec-aaa',
        messageId: 'msg-1',
        transcriptionStatus: 'PUBLISHED',
        transcriptionFailed: false,
        failedReason: null,
        frequencyKhz: 11175,
        modulation: 'USB',
        broadcastedAt: '2026-05-28T18:59:00Z',
        durationMs: 4200,
        automated: true,
      }),
    ]);
    await waitFor(() => expect(screen.getByText('Published')).toBeInTheDocument());
    expect(screen.getByText(/11\.175 MHz · USB/)).toBeInTheDocument();
    expect(screen.getByText(/Uploaded /)).toBeInTheDocument();
    expect(screen.getByText(/Broadcast /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open message/i })).toBeInTheDocument();
  });

  it('surfaces failure reason inline for failed rows', async () => {
    render(<UploadsList uploaderId="sub-1" />);
    emit([row()]);
    expect(await screen.findByText('whisper.cpp exit 1')).toBeInTheDocument();
    expect(screen.getByText(/transcribe failed/i)).toBeInTheDocument();
  });

  it('advances status live on a subscription tick (#774)', async () => {
    render(<UploadsList uploaderId="sub-1" />);
    emit([
      row({
        id: 'rec-x',
        transcriptionStatus: 'TRANSCRIBING',
        transcriptionFailed: false,
        failedReason: null,
      }),
    ]);
    await waitFor(() => expect(screen.getByText('Transcribing')).toBeInTheDocument());
    // Next snapshot: the same recording reaches PUBLISHED.
    emit([
      row({
        id: 'rec-x',
        transcriptionStatus: 'PUBLISHED',
        transcriptionFailed: false,
        failedReason: null,
      }),
    ]);
    await waitFor(() => expect(screen.getByText('Published')).toBeInTheDocument());
  });

  it('keeps showing the list when the live subscription errors (no blanking) (#774 fix)', async () => {
    listMock.mockResolvedValue({ items: [row({ id: 'rec-keep' })], nextToken: null });
    render(<UploadsList uploaderId="sub-1" />);
    // Initial list paints.
    await waitFor(() => expect(screen.getByText('whisper.cpp exit 1')).toBeInTheDocument());
    // A subscription error must NOT blank the page or show a banner.
    act(() => captured?.error?.({ errors: [{ message: 'connection lost' }] }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('whisper.cpp exit 1')).toBeInTheDocument();
  });

  it('shows a readable error (not "[object Object]") when the initial list fails (#774 fix)', async () => {
    // AppSync errors are plain objects, not Error instances.
    listMock.mockRejectedValue({ errors: [{ message: 'Unauthorized' }] });
    render(<UploadsList uploaderId="sub-1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Unauthorized/i);
    expect(alert).not.toHaveTextContent(/\[object Object\]/);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<UploadsList uploaderId="sub-1" />);
    emit([row()]);
    unmount();
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('hides the Reprocess button for a non-mod/admin member (#505)', async () => {
    groupsMock.mockReturnValue(['member']);
    render(<UploadsList uploaderId="sub-1" />);
    emit([row()]);
    await waitFor(() => expect(screen.getByText('whisper.cpp exit 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /reprocess/i })).not.toBeInTheDocument();
  });

  it('calls the reprocess mutation; the live query carries the row to queued (#505/#774)', async () => {
    groupsMock.mockReturnValue(['admin']);
    render(<UploadsList uploaderId="sub-1" />);
    emit([row()]);
    const btn = await screen.findByRole('button', { name: /reprocess/i });
    fireEvent.click(btn);
    await waitFor(() => expect(reprocessMock).toHaveBeenCalledWith('rec-ccc'));
    // Server resets to QUEUED → next snapshot reflects it (no optimistic patch).
    emit([row({ transcriptionStatus: 'QUEUED', transcriptionFailed: false, failedReason: null })]);
    await waitFor(() => expect(screen.getByText('Queued')).toBeInTheDocument());
    expect(screen.queryByText('whisper.cpp exit 1')).not.toBeInTheDocument();
  });

  it('hides Reprocess for a recording-less row (no originalKey) even for admins (#505)', async () => {
    groupsMock.mockReturnValue(['admin']);
    render(<UploadsList uploaderId="sub-1" />);
    emit([row({ originalKey: null })]);
    await waitFor(() => expect(screen.getByText('whisper.cpp exit 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /reprocess/i })).not.toBeInTheDocument();
  });
});
