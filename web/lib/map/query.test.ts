import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadMapData } from './query';
import type { RawTransmitter, RawSdrPublic } from './points';

const transmitterListMock = vi.fn();
const sdrQueryMock = vi.fn();

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    models: {
      Transmitter: {
        list: transmitterListMock,
      },
    },
    queries: {
      listSdrPublic: sdrQueryMock,
    },
  }),
}));

vi.mock('@/lib/auth/mode', () => ({
  resolveAuthMode: vi.fn().mockResolvedValue('identityPool'),
}));

describe('loadMapData', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const mockTransmitters: RawTransmitter[] = [
      { id: 't1', name: 'TX1', latitude: 10, longitude: 20 },
    ];
    const mockSdrs: RawSdrPublic[] = [
      { id: 's1', name: 'SDR1', latitude: 30, longitude: 40, locationGranularity: 'EXACT' },
    ];

    transmitterListMock.mockResolvedValue({ data: mockTransmitters, errors: null });
    sdrQueryMock.mockResolvedValue({ data: mockSdrs, errors: null });
  });

  it('loads both transmitters and SDRs when both succeed', async () => {
    const data = await loadMapData();
    expect(data.transmitterCount).toBe(1);
    expect(data.sdrCount).toBe(1);
    expect(data.points).toHaveLength(2);
  });

  it('renders transmitters when SDR query fails', async () => {
    sdrQueryMock.mockRejectedValue(new Error('SDR fetch failed'));
    const data = await loadMapData();
    expect(data.transmitterCount).toBe(1);
    expect(data.sdrCount).toBe(0);
    expect(data.points.filter((p) => p.type === 'transmitter')).toHaveLength(1);
  });

  it('renders SDRs when transmitter list fails', async () => {
    transmitterListMock.mockRejectedValue(new Error('Transmitter fetch failed'));
    const data = await loadMapData();
    expect(data.transmitterCount).toBe(0);
    expect(data.sdrCount).toBe(1);
    expect(data.points.filter((p) => p.type === 'sdr')).toHaveLength(1);
  });

  it('throws when both sources fail', async () => {
    transmitterListMock.mockRejectedValue(new Error('Transmitter failed'));
    sdrQueryMock.mockRejectedValue(new Error('SDR failed'));
    await expect(loadMapData()).rejects.toThrow(/Map data sources failed/);
  });
});
