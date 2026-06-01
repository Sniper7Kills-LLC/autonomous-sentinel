import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ModerationQueue } from './ModerationQueue';
import type { QueueItem } from '@/lib/admin/moderation';

const listMock = vi.fn<() => Promise<QueueItem[]>>();
const hideMock = vi.fn<(id: string, hidden: boolean) => Promise<void>>();
const clearFlagMock = vi.fn<(id: string) => Promise<void>>();
const resolveMock = vi.fn<(id: string, status: string) => Promise<void>>();

vi.mock('@/lib/admin/moderation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listModerationQueue: () => listMock(),
    setQueueCommentHidden: (id: string, hidden: boolean) => hideMock(id, hidden),
    clearMessageFlag: (id: string) => clearFlagMock(id),
    resolveAbuseReport: (id: string, status: string) => resolveMock(id, status),
  };
});

function item(p: Partial<QueueItem>): QueueItem {
  return {
    key: 'COMMENT#c1',
    source: 'COMMENT',
    targetId: 'c1',
    sourceLabel: 'Flagged comment',
    summary: 'bad words',
    reporter: null,
    reason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    href: '/messages/view?id=m1',
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset();
  hideMock.mockReset().mockResolvedValue(undefined);
  clearFlagMock.mockReset().mockResolvedValue(undefined);
  resolveMock.mockReset().mockResolvedValue(undefined);
});

describe('ModerationQueue', () => {
  it('renders mixed source rows with content links', async () => {
    listMock.mockResolvedValue([
      item({ key: 'COMMENT#c1', source: 'COMMENT', summary: 'bad words' }),
      item({
        key: 'MESSAGE#m9',
        source: 'MESSAGE',
        targetId: 'm9',
        sourceLabel: 'Flagged message',
        summary: 'SKYKING msg',
        href: '/messages/view?id=m9',
      }),
      item({
        key: 'ABUSE_REPORT#r1',
        source: 'ABUSE_REPORT',
        targetId: 'r1',
        sourceLabel: 'User report',
        summary: 'spam report',
        reporter: 'sub-7',
        reason: 'SPAM',
        href: null,
      }),
    ]);
    render(<ModerationQueue />);
    await waitFor(() => expect(screen.getByTestId('mod-queue-list')).toBeInTheDocument());
    expect(screen.getByText('bad words')).toBeInTheDocument();
    expect(screen.getByText('SKYKING msg')).toBeInTheDocument();
    expect(screen.getByText('spam report')).toBeInTheDocument();
    // link resolves to message detail
    expect(screen.getAllByRole('link', { name: /view content/i })[0]).toHaveAttribute(
      'href',
      '/messages/view?id=m1',
    );
    expect(screen.getByText('3 pending')).toBeInTheDocument();
  });

  it('filters by source type', async () => {
    listMock.mockResolvedValue([
      item({ key: 'COMMENT#c1', source: 'COMMENT', summary: 'a comment' }),
      item({
        key: 'MESSAGE#m9',
        source: 'MESSAGE',
        targetId: 'm9',
        summary: 'a message',
        href: '/messages/view?id=m9',
      }),
    ]);
    render(<ModerationQueue />);
    await waitFor(() => expect(screen.getByText('a comment')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(screen.queryByText('a comment')).not.toBeInTheDocument();
    expect(screen.getByText('a message')).toBeInTheDocument();
  });

  it('hide action calls the comment wrapper and drops the row', async () => {
    listMock.mockResolvedValue([item({ key: 'COMMENT#c1', source: 'COMMENT', targetId: 'c1' })]);
    render(<ModerationQueue />);
    await waitFor(() => expect(screen.getByText('bad words')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(hideMock).toHaveBeenCalledWith('c1', true));
    await waitFor(() => expect(screen.queryByText('bad words')).not.toBeInTheDocument());
  });

  it('clear-flag action calls clearMessageFlag', async () => {
    listMock.mockResolvedValue([
      item({
        key: 'MESSAGE#m9',
        source: 'MESSAGE',
        targetId: 'm9',
        summary: 'flagged msg',
        href: '/messages/view?id=m9',
      }),
    ]);
    render(<ModerationQueue />);
    await waitFor(() => expect(screen.getByText('flagged msg')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Clear flag' }));
    await waitFor(() => expect(clearFlagMock).toHaveBeenCalledWith('m9'));
  });

  it('resolve action calls resolveAbuseReport with RESOLVED', async () => {
    listMock.mockResolvedValue([
      item({
        key: 'ABUSE_REPORT#r1',
        source: 'ABUSE_REPORT',
        targetId: 'r1',
        summary: 'spam',
        reporter: 'sub-1',
        reason: 'SPAM',
        href: null,
      }),
    ]);
    render(<ModerationQueue />);
    await waitFor(() => expect(screen.getByText('spam')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(resolveMock).toHaveBeenCalledWith('r1', 'RESOLVED'));
  });

  it('shows an empty state', async () => {
    listMock.mockResolvedValue([]);
    render(<ModerationQueue />);
    await waitFor(() => expect(screen.getByText('Nothing in the queue.')).toBeInTheDocument());
  });
});
