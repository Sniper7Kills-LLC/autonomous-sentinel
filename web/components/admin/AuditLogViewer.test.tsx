import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AuditLogViewer } from './AuditLogViewer';
import type { AuditRow, ListAuditResult, AuditFilter, ListAuditOptions } from '@/lib/admin/audit';

const listMock = vi.fn<(f?: AuditFilter, o?: ListAuditOptions) => Promise<ListAuditResult>>();

vi.mock('@/lib/admin/audit', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    // keep pure helpers (buildAuditFilter, toCsv, jsonDiff, …) real;
    // only the network list is mocked.
    listAudit: (f?: AuditFilter, o?: ListAuditOptions) => listMock(f, o),
  };
});

function auditRow(p: Partial<AuditRow>): AuditRow {
  return {
    id: 'a1',
    actorId: 'sub-123',
    action: 'MESSAGE_DELETE',
    targetType: 'Message',
    targetId: 'm1',
    targetMessageId: 'm1',
    diff: { before: { type: 'B' }, after: { type: 'D' } },
    reason: 'spam',
    ipAddress: null,
    userAgent: null,
    claimId: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset();
});

describe('AuditLogViewer', () => {
  it('renders rows from the loaded audit log', async () => {
    listMock.mockResolvedValue({ items: [auditRow({})], nextToken: null });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('MESSAGE_DELETE')).toBeInTheDocument());
    expect(screen.getByText('sub-123')).toBeInTheDocument();
    expect(screen.getByText('spam')).toBeInTheDocument();
  });

  it('labels a null actor as SYSTEM', async () => {
    listMock.mockResolvedValue({
      items: [auditRow({ id: 'sys', actorId: null, action: 'FIELDVOTE_ORPHAN_SWEEP' })],
      nextToken: null,
    });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('SYSTEM')).toBeInTheDocument());
  });

  it('applies a filter and re-queries with the chosen action', async () => {
    listMock.mockResolvedValue({ items: [auditRow({})], nextToken: null });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('MESSAGE_DELETE')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'USER_BAN' } });
    fireEvent.click(screen.getByText('Apply filters'));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'USER_BAN' }),
        expect.anything(),
      ),
    );
  });

  it('expands a row to show the before/after diff', async () => {
    listMock.mockResolvedValue({ items: [auditRow({})], nextToken: null });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('MESSAGE_DELETE')).toBeInTheDocument());

    const toggle = screen.getByRole('button', { name: 'View diff' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    const diff = await screen.findByLabelText('Before / after diff');
    expect(diff.textContent).toContain('"B"');
    expect(diff.textContent).toContain('"D"');
    expect(screen.getByRole('button', { name: 'Hide diff' })).toBeInTheDocument();
  });

  it('renders the CSV export button', async () => {
    listMock.mockResolvedValue({ items: [auditRow({})], nextToken: null });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('MESSAGE_DELETE')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('shows a Load more button when a nextToken is present and pages', async () => {
    listMock.mockResolvedValueOnce({ items: [auditRow({ id: 'a1' })], nextToken: 'tok1' });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('MESSAGE_DELETE')).toBeInTheDocument());

    listMock.mockResolvedValueOnce({
      items: [auditRow({ id: 'a2', action: 'USER_BAN' })],
      nextToken: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getAllByText('USER_BAN').length).toBeGreaterThan(0));
    // both pages' rows are present (the dropdown option also carries the
    // action label, so assert on presence rather than exact count).
    expect(screen.getAllByText('MESSAGE_DELETE').length).toBeGreaterThan(0);
    expect(listMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ nextToken: 'tok1' }),
    );
  });

  it('keeps the merged set globally newest-first when page 2 is older than page 1', async () => {
    // Page 1: a newer row. Each page arrives independently sorted, so the
    // older page-2 row must still sort ABOVE nothing and BELOW page 1.
    listMock.mockResolvedValueOnce({
      items: [
        auditRow({
          id: 'p1',
          action: 'USER_BAN',
          createdAt: '2026-05-20T00:00:00.000Z',
        }),
      ],
      nextToken: 'tok1',
    });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getAllByText('USER_BAN').length).toBeGreaterThan(0));

    // Page 2: a row OLDER than every page-1 row.
    listMock.mockResolvedValueOnce({
      items: [
        auditRow({
          id: 'p2',
          action: 'MESSAGE_RESTORE',
          createdAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
      nextToken: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByText('MESSAGE_RESTORE').length).toBeGreaterThan(0));

    // Read the timestamp cells in render order; they must be descending.
    const timestamps = screen.getAllByText(/^2026-05-\d{2}T/).map((el) => el.textContent ?? '');
    const sorted = [...timestamps].sort((a, b) => b.localeCompare(a));
    expect(timestamps).toEqual(sorted);
    // Sanity: the newer page-1 row precedes the older page-2 row.
    expect(timestamps.indexOf('2026-05-20T00:00:00.000Z')).toBeLessThan(
      timestamps.indexOf('2026-05-01T00:00:00.000Z'),
    );
  });

  it('has no mutation affordances (display-only)', async () => {
    listMock.mockResolvedValue({ items: [auditRow({})], nextToken: null });
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByText('MESSAGE_DELETE')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /delete|ban|edit|restore/i })).toBeNull();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('Unauthorized'));
    render(<AuditLogViewer />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unauthorized'));
  });
});
