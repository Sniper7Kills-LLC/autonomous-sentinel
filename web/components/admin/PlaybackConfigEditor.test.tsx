import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PlaybackConfigEditor } from './PlaybackConfigEditor';
import type { PlaybackConfigRow, PlaybackConfigValues } from '@/lib/admin/playback-config';

const getMock = vi.fn<() => Promise<PlaybackConfigRow | null>>();
const saveMock =
  vi.fn<
    (
      input: PlaybackConfigValues,
      opts: { exists: boolean; notes?: string },
    ) => Promise<PlaybackConfigRow>
  >();

vi.mock('@/lib/admin/playback-config', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getPlaybackConfig: () => getMock(),
    savePlaybackConfig: (input: PlaybackConfigValues, opts: { exists: boolean; notes?: string }) =>
      saveMock(input, opts),
  };
});

function row(p: Partial<PlaybackConfigRow> = {}): PlaybackConfigRow {
  return {
    key: 'default',
    requestsPerMinute: 60,
    bytesPerHour: 1073741824,
    signedUrlTtlSeconds: 300,
    notes: '',
    updatedAt: null,
    ...p,
  };
}

beforeEach(() => {
  getMock.mockReset();
  saveMock.mockReset().mockImplementation((input) => Promise.resolve(row(input)));
});

describe('PlaybackConfigEditor', () => {
  it('seeds the form with defaults when no row exists', async () => {
    getMock.mockResolvedValue(null);
    render(<PlaybackConfigEditor />);
    await waitFor(() =>
      expect(screen.getByLabelText('Requests per minute (per IP)')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Requests per minute (per IP)')).toHaveValue(60);
    expect(screen.getByLabelText('Signed-URL TTL (seconds)')).toHaveValue(300);
  });

  it('seeds the form from an existing row', async () => {
    getMock.mockResolvedValue(row({ requestsPerMinute: 30, signedUrlTtlSeconds: 600 }));
    render(<PlaybackConfigEditor />);
    await waitFor(() =>
      expect(screen.getByLabelText('Requests per minute (per IP)')).toHaveValue(30),
    );
    expect(screen.getByLabelText('Signed-URL TTL (seconds)')).toHaveValue(600);
  });

  it('creates on first save (exists=false)', async () => {
    getMock.mockResolvedValue(null);
    render(<PlaybackConfigEditor />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]).toMatchObject({ exists: false });
  });

  it('updates when a row already exists (exists=true)', async () => {
    getMock.mockResolvedValue(row({ requestsPerMinute: 30 }));
    render(<PlaybackConfigEditor />);
    await waitFor(() =>
      expect(screen.getByLabelText('Requests per minute (per IP)')).toHaveValue(30),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0]?.[1]).toMatchObject({ exists: true });
  });

  it('blocks save and shows a field error on invalid TTL', async () => {
    getMock.mockResolvedValue(null);
    render(<PlaybackConfigEditor />);
    await waitFor(() =>
      expect(screen.getByLabelText('Signed-URL TTL (seconds)')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Signed-URL TTL (seconds)'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText(/TTL must be between 30 and 3600 seconds\./)).toBeInTheDocument(),
    );
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('renders the deferred-stats placeholder (no fabricated stats)', async () => {
    getMock.mockResolvedValue(null);
    render(<PlaybackConfigEditor />);
    await waitFor(() => expect(screen.getByText('Playback stats')).toBeInTheDocument());
    expect(
      screen.getByText(/once the playback \/ signed-URL pipeline emits playback counters/),
    ).toBeInTheDocument();
  });
});
