import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mock = ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<unknown>>>;
const runMock: Mock = vi.fn();

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    mutations: {
      runCostSnapshotNow: (...a: unknown[]): Promise<unknown> => runMock(...a),
    },
  }),
}));

import { runCostSnapshotNow } from './transparency';

beforeEach(() => {
  runMock.mockReset();
});

describe('runCostSnapshotNow (#644)', () => {
  it('calls the mutation with the userPool auth mode and returns the summary', async () => {
    runMock.mockResolvedValue({
      data: { snapshotDate: '2026-05-31', rowsWritten: 7, totalUsd: 12.34 },
      errors: null,
    });

    const result = await runCostSnapshotNow();

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith({}, { authMode: 'userPool' });
    expect(result).toEqual({ snapshotDate: '2026-05-31', rowsWritten: 7, totalUsd: 12.34 });
  });

  it('parses a JSON-string data payload (a.json() return shape)', async () => {
    runMock.mockResolvedValue({
      data: JSON.stringify({ snapshotDate: '2026-05-31', rowsWritten: 3, totalUsd: 2.5 }),
      errors: null,
    });

    const result = await runCostSnapshotNow();

    expect(result).toEqual({ snapshotDate: '2026-05-31', rowsWritten: 3, totalUsd: 2.5 });
  });

  it('throws when the mutation returns GraphQL errors', async () => {
    runMock.mockResolvedValue({ data: null, errors: [{ message: 'Unauthorized' }] });

    await expect(runCostSnapshotNow()).rejects.toThrow(/Unauthorized/);
  });

  it('coerces a missing/garbage payload to a safe zero summary', async () => {
    runMock.mockResolvedValue({ data: null, errors: null });

    const result = await runCostSnapshotNow();

    expect(result).toEqual({ snapshotDate: '', rowsWritten: 0, totalUsd: 0 });
  });
});
