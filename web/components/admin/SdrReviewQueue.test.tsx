import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SdrReviewQueue } from './SdrReviewQueue';
import type { SdrRow } from '@/lib/sdr';
import type * as SdrModule from '@/lib/sdr';

/**
 * Tests for SdrReviewQueue admin component (#785).
 */

const mockListPending = vi.fn<() => Promise<SdrRow[]>>();
const mockReviewSdr = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/sdr', async () => {
  const actual = await vi.importActual<typeof SdrModule>('@/lib/sdr');
  return {
    ...actual,
    listPendingPublicSdrs: () => mockListPending(),
    reviewSdr: (...args: unknown[]) => mockReviewSdr(...args),
  };
});

const PENDING_A: SdrRow = {
  id: 'sdr-001',
  name: 'KiwiSDR London',
  kind: 'PUBLIC',
  url: 'http://rx1.example.com:8073',
  latitude: 51.5074,
  longitude: -0.1278,
  locationGranularity: 'CITY',
  publicVisible: false,
  notes: 'Covers HF bands 1-30 MHz',
  reviewStatus: 'PENDING',
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  submitterId: 'cog-member-001',
  ownerId: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const APPROVED_SDR: SdrRow = {
  ...PENDING_A,
  reviewStatus: 'APPROVED',
  reviewedBy: 'cog-admin-001',
  reviewedAt: '2025-01-02T00:00:00Z',
};

describe('SdrReviewQueue', () => {
  beforeEach(() => {
    mockListPending.mockReset();
    mockReviewSdr.mockReset();
    mockListPending.mockResolvedValue([]);
  });

  it('shows empty state when no pending submissions', async () => {
    render(<SdrReviewQueue />);
    expect(await screen.findByText('No pending SDR submissions.')).toBeInTheDocument();
  });

  it('lists pending SDRs with name, URL, and badge', async () => {
    mockListPending.mockResolvedValue([PENDING_A]);
    render(<SdrReviewQueue />);
    expect(await screen.findByText('KiwiSDR London')).toBeInTheDocument();
    expect(screen.getByText('http://rx1.example.com:8073')).toBeInTheDocument();
    expect(screen.getByText('PUBLIC · PENDING')).toBeInTheDocument();
    expect(screen.getByText('Covers HF bands 1-30 MHz')).toBeInTheDocument();
  });

  it('calls reviewSdr with APPROVED when approve clicked', async () => {
    mockListPending.mockResolvedValue([PENDING_A]);
    mockReviewSdr.mockResolvedValue(APPROVED_SDR);
    mockListPending.mockResolvedValueOnce([PENDING_A]).mockResolvedValue([]);
    render(<SdrReviewQueue />);
    await screen.findByText('KiwiSDR London');

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    await waitFor(() => {
      expect(mockReviewSdr).toHaveBeenCalledWith('sdr-001', 'APPROVED', undefined);
    });
    // After reload, pending list is empty
    expect(await screen.findByText('No pending SDR submissions.')).toBeInTheDocument();
  });

  it('calls reviewSdr with REJECTED when reject clicked', async () => {
    mockListPending.mockResolvedValue([PENDING_A]);
    mockReviewSdr.mockResolvedValue({ ...PENDING_A, reviewStatus: 'REJECTED' });
    mockListPending.mockResolvedValueOnce([PENDING_A]).mockResolvedValue([]);
    render(<SdrReviewQueue />);
    await screen.findByText('KiwiSDR London');

    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));

    await waitFor(() => {
      expect(mockReviewSdr).toHaveBeenCalledWith('sdr-001', 'REJECTED', undefined);
    });
    expect(await screen.findByText('No pending SDR submissions.')).toBeInTheDocument();
  });

  it('passes the review note when set', async () => {
    mockListPending.mockResolvedValue([PENDING_A]);
    mockReviewSdr.mockResolvedValue(APPROVED_SDR);
    mockListPending.mockResolvedValueOnce([PENDING_A]).mockResolvedValue([]);
    render(<SdrReviewQueue />);
    await screen.findByText('KiwiSDR London');

    const noteInput = screen.getByPlaceholderText(/Reason for approval/);
    fireEvent.change(noteInput, { target: { value: 'Verified manually' } });

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    await waitFor(() => {
      expect(mockReviewSdr).toHaveBeenCalledWith('sdr-001', 'APPROVED', 'Verified manually');
    });
  });

  it('shows error when reviewSdr fails', async () => {
    mockListPending.mockResolvedValue([PENDING_A]);
    mockReviewSdr.mockRejectedValue(new Error('Network error'));
    render(<SdrReviewQueue />);
    await screen.findByText('KiwiSDR London');

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    mockListPending.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SdrReviewQueue />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows location when available', async () => {
    mockListPending.mockResolvedValue([PENDING_A]);
    render(<SdrReviewQueue />);
    await screen.findByText('KiwiSDR London');
    expect(screen.getByText(/51\.5074/)).toBeInTheDocument();
    expect(screen.getByText(/-0\.1278/)).toBeInTheDocument();
  });
});
