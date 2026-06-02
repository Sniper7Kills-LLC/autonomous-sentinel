import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DlqList } from './DlqList';
import type { DlqMessageView, PipelineStage } from '@/lib/dlq/query';

const listMock = vi.fn<(stage: PipelineStage) => Promise<DlqMessageView[]>>();
const requeueMock = vi.fn<(m: DlqMessageView) => Promise<void>>();
const dropMock = vi.fn<(m: DlqMessageView) => Promise<void>>();

vi.mock('@/lib/dlq/query', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listDlqMessages: (stage: PipelineStage) => listMock(stage),
    requeueDlqMessage: (m: DlqMessageView) => requeueMock(m),
    dropDlqMessage: (m: DlqMessageView) => dropMock(m),
  };
});

function msg(p: Partial<DlqMessageView>): DlqMessageView {
  return {
    stage: 'preprocess',
    messageId: 'm1',
    receiptHandle: 'rh1',
    body: '{"recordingId":"rec-1"}',
    recordingId: 'rec-1',
    approximateReceiveCount: 3,
    enqueuedAt: '2026-06-01T00:00:00.000Z',
    errorReason: 'ffmpeg failed',
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset();
  requeueMock.mockReset().mockResolvedValue();
  dropMock.mockReset().mockResolvedValue();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('DlqList (#107)', () => {
  it('loads + renders the preprocess DLQ on mount', async () => {
    listMock.mockResolvedValue([msg({})]);
    render(<DlqList />);
    await waitFor(() => expect(screen.getByText('rec-1')).toBeInTheDocument());
    expect(listMock).toHaveBeenCalledWith('preprocess');
    expect(screen.getByText('ffmpeg failed')).toBeInTheDocument();
  });

  it('shows the empty state when a DLQ is clear', async () => {
    listMock.mockResolvedValue([]);
    render(<DlqList />);
    await waitFor(() => expect(screen.getByText(/No stuck messages/)).toBeInTheDocument());
  });

  it('retries a single message and removes it from the list', async () => {
    listMock.mockResolvedValue([msg({})]);
    render(<DlqList />);
    await waitFor(() => expect(screen.getByText('rec-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(requeueMock).toHaveBeenCalledTimes(1));
    expect(requeueMock).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1' }));
    await waitFor(() => expect(screen.queryByText('rec-1')).not.toBeInTheDocument());
  });

  it('confirms before dropping and skips when cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    listMock.mockResolvedValue([msg({})]);
    render(<DlqList />);
    await waitFor(() => expect(screen.getByText('rec-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    expect(dropMock).not.toHaveBeenCalled();
    expect(screen.getByText('rec-1')).toBeInTheDocument();
  });

  it('switches stages and re-queries', async () => {
    listMock.mockImplementation((stage) =>
      Promise.resolve(
        stage === 'transcribe' ? [msg({ messageId: 'm2', recordingId: 'rec-2' })] : [msg({})],
      ),
    );
    render(<DlqList />);
    await waitFor(() => expect(screen.getByText('rec-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Transcribe/ }));
    await waitFor(() => expect(screen.getByText('rec-2')).toBeInTheDocument());
    expect(listMock).toHaveBeenCalledWith('transcribe');
  });

  it('filters rows by error text', async () => {
    listMock.mockResolvedValue([
      msg({ messageId: 'm1', recordingId: 'rec-1', errorReason: 'ffmpeg failed' }),
      msg({ messageId: 'm2', recordingId: 'rec-2', errorReason: 'bedrock throttled' }),
    ]);
    render(<DlqList />);
    await waitFor(() => expect(screen.getByText('rec-1')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter messages'), { target: { value: 'bedrock' } });
    expect(screen.queryByText('rec-1')).not.toBeInTheDocument();
    expect(screen.getByText('rec-2')).toBeInTheDocument();
  });
});
