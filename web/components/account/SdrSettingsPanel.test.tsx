import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SdrSettingsPanel } from './SdrSettingsPanel';
import type { SdrRow } from '@/lib/sdr';
import type * as SdrModule from '@/lib/sdr';

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ sub: 'cog-member-001', loading: false }),
  useCallerGroups: () => ({ groups: ['member'], loading: false }),
}));

/**
 * Tests for SdrSettingsPanel (#785).
 * Mocks the data layer (listMySdrs, createOwnedSdr, submitPublicSdr).
 */

const mockListMySdrs = vi.fn<() => Promise<SdrRow[]>>();
const mockCreateOwnedSdr = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubmitPublicSdr = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/lib/sdr', async () => {
  const actual = await vi.importActual<typeof SdrModule>('@/lib/sdr');
  return {
    ...actual,
    listMySdrs: () => mockListMySdrs(),
    createOwnedSdr: (...args: unknown[]) => mockCreateOwnedSdr(...args),
    submitPublicSdr: (...args: unknown[]) => mockSubmitPublicSdr(...args),
  };
});

// Stub LocationPicker (no WebGL in jsdom)
vi.mock('@/components/map/LocationPicker', () => ({
  LocationPicker: ({
    onChange,
    label,
  }: {
    onChange: (lat: number, lng: number) => void;
    label?: string;
  }) => (
    <div>
      <span>{label}</span>
      <button onClick={() => onChange(51.5074, -0.1278)}>Set location</button>
    </div>
  ),
}));

// Stub dynamic import of LocationPicker (next/dynamic)
vi.mock('next/dynamic', () => ({
  default: (fn: () => Promise<{ LocationPicker: unknown }>) => {
    // Return a synchronous component that just calls the stub
    const Component = ({
      onChange,
      label,
    }: {
      onChange: (lat: number, lng: number) => void;
      label?: string;
    }) => (
      <div>
        <span>{label ?? ''}</span>
        <button onClick={() => onChange(51.5074, -0.1278)}>Set location</button>
      </div>
    );
    Component.displayName = 'LocationPickerDynamic';
    void fn; // suppress unused warning
    return Component;
  },
}));

const OWNED_SDR: SdrRow = {
  id: 'sdr-001',
  name: 'My Home SDR',
  kind: 'OWNED',
  url: null,
  latitude: 51.5074,
  longitude: -0.1278,
  locationGranularity: 'CITY',
  publicVisible: true,
  notes: null,
  reviewStatus: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  submitterId: null,
  ownerId: 'cog-member-001',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const PENDING_SDR: SdrRow = {
  id: 'sdr-002',
  name: 'KiwiSDR Tokyo',
  kind: 'PUBLIC',
  url: 'http://example.com:8073',
  latitude: 35.6895,
  longitude: 139.6917,
  locationGranularity: 'CITY',
  publicVisible: false,
  notes: null,
  reviewStatus: 'PENDING',
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  submitterId: 'cog-member-001',
  ownerId: null,
  createdAt: '2025-01-02T00:00:00Z',
  updatedAt: '2025-01-02T00:00:00Z',
};

describe('SdrSettingsPanel', () => {
  beforeEach(() => {
    mockListMySdrs.mockReset();
    mockCreateOwnedSdr.mockReset();
    mockSubmitPublicSdr.mockReset();
    mockListMySdrs.mockResolvedValue([]);
  });

  it('renders the three tabs', () => {
    render(<SdrSettingsPanel />);
    expect(screen.getByRole('tab', { name: /My SDRs/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Register Owned SDR/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Submit Public SDR/ })).toBeInTheDocument();
  });

  it('shows empty state when no SDRs', async () => {
    render(<SdrSettingsPanel />);
    expect(await screen.findByText(/No SDRs yet/)).toBeInTheDocument();
  });

  it('lists existing SDRs with kind badges', async () => {
    mockListMySdrs.mockResolvedValue([OWNED_SDR, PENDING_SDR]);
    render(<SdrSettingsPanel />);
    expect(await screen.findByText('My Home SDR')).toBeInTheDocument();
    expect(await screen.findByText('KiwiSDR Tokyo')).toBeInTheDocument();
    expect(screen.getByText('Owned SDR')).toBeInTheDocument();
    expect(screen.getByText('Public SDR')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
  });

  it('switches to owned SDR form on tab click', async () => {
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Register Owned SDR/ }));
    expect(await screen.findByRole('form', { name: /Register owned SDR/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toBeInTheDocument();
  });

  it('switches to public SDR form on tab click', async () => {
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Submit Public SDR/ }));
    expect(await screen.findByRole('form', { name: /Submit public SDR/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Stream URL *')).toBeInTheDocument();
  });

  it('validates required name on owned SDR form', async () => {
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Register Owned SDR/ }));
    await screen.findByRole('form', { name: /Register owned SDR/ });
    fireEvent.click(screen.getByRole('button', { name: /Register SDR/ }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });

  it('validates required name and url on public SDR form', async () => {
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Submit Public SDR/ }));
    await screen.findByRole('form', { name: /Submit public SDR/ });
    fireEvent.click(screen.getByRole('button', { name: /Submit for review/ }));
    const errors = await screen.findAllByRole('alert');
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('submits owned SDR and returns to list', async () => {
    mockCreateOwnedSdr.mockResolvedValue(OWNED_SDR);
    mockListMySdrs.mockResolvedValueOnce([]).mockResolvedValueOnce([OWNED_SDR]);
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Register Owned SDR/ }));
    await screen.findByRole('form', { name: /Register owned SDR/ });

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'My Home SDR' } });
    fireEvent.click(screen.getByRole('button', { name: /Register SDR/ }));

    await waitFor(() => {
      expect(mockCreateOwnedSdr).toHaveBeenCalled();
    });
    // Should switch back to list tab
    expect(await screen.findByText('My Home SDR')).toBeInTheDocument();
  });

  it('submits public SDR and returns to list', async () => {
    mockSubmitPublicSdr.mockResolvedValue(PENDING_SDR);
    mockListMySdrs.mockResolvedValueOnce([]).mockResolvedValueOnce([PENDING_SDR]);
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Submit Public SDR/ }));
    await screen.findByRole('form', { name: /Submit public SDR/ });

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'KiwiSDR Tokyo' } });
    fireEvent.change(screen.getByLabelText('Stream URL *'), {
      target: { value: 'http://example.com:8073' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit for review/ }));

    await waitFor(() => {
      expect(mockSubmitPublicSdr).toHaveBeenCalled();
    });
    expect(await screen.findByText('KiwiSDR Tokyo')).toBeInTheDocument();
  });

  it('shows error when createOwnedSdr fails', async () => {
    mockCreateOwnedSdr.mockRejectedValue(new Error('Server error'));
    render(<SdrSettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Register Owned SDR/ }));
    await screen.findByRole('form', { name: /Register owned SDR/ });

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Test SDR' } });
    fireEvent.click(screen.getByRole('button', { name: /Register SDR/ }));

    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });
});
