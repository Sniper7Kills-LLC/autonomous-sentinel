import { describe, it, expect } from 'vitest';
import {
  transmittersToPoints,
  sdrsToPoints,
  toMapPoints,
  formatFrequencies,
  granularityLabel,
  type RawSdrPublic,
  type RawTransmitter,
} from './points';

describe('transmittersToPoints', () => {
  it('projects a transmitter row into a MapPoint', () => {
    const rows: RawTransmitter[] = [
      {
        id: 't1',
        name: 'Andrews HFGCS',
        latitude: 38.81,
        longitude: -76.87,
        callsign: 'ADW',
        frequencyKhzList: [11175, 8992],
        notes: 'primary site',
      },
    ];
    const pts = transmittersToPoints(rows);
    expect(pts).toHaveLength(1);
    const [pt] = pts;
    expect(pt).toMatchObject({
      type: 'transmitter',
      id: 't1',
      name: 'Andrews HFGCS',
      lat: 38.81,
      lon: -76.87,
    });
    expect(pt?.meta.callsign).toBe('ADW');
    expect(pt?.meta.frequencyKhzList).toEqual([11175, 8992]);
    expect(pt?.meta.notes).toBe('primary site');
  });

  it('drops rows with null / missing coordinates', () => {
    const rows: RawTransmitter[] = [
      { id: 'a', name: 'no lat', latitude: null, longitude: -76 },
      { id: 'b', name: 'no lon', latitude: 38, longitude: null },
      { id: 'c', name: 'neither' },
      { id: 'd', name: 'ok', latitude: 10, longitude: 20 },
    ];
    const pts = transmittersToPoints(rows);
    expect(pts.map((p) => p.id)).toEqual(['d']);
  });

  it('drops NaN / out-of-range coordinates', () => {
    const rows: RawTransmitter[] = [
      { id: 'nan', name: 'nan', latitude: Number.NaN, longitude: 0 },
      { id: 'inf', name: 'inf', latitude: Number.POSITIVE_INFINITY, longitude: 0 },
      { id: 'oob', name: 'oob', latitude: 200, longitude: 0 },
    ];
    expect(transmittersToPoints(rows)).toHaveLength(0);
  });

  it('falls back to a placeholder name and cleans null freqs', () => {
    const rows: RawTransmitter[] = [
      {
        id: 'x',
        name: '   ',
        latitude: 1,
        longitude: 2,
        frequencyKhzList: [null, 8992, null],
      },
    ];
    const pts = transmittersToPoints(rows);
    expect(pts[0]?.name).toBe('Unnamed transmitter');
    expect(pts[0]?.meta.frequencyKhzList).toEqual([8992]);
  });
});

describe('sdrsToPoints', () => {
  it('projects a public SDR row with granularity', () => {
    const rows: RawSdrPublic[] = [
      {
        id: 's1',
        name: 'KX0ABC',
        latitude: 40.0,
        longitude: -105.0,
        locationGranularity: 'CITY',
        notes: 'shack',
      },
    ];
    const pts = sdrsToPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ type: 'sdr', id: 's1', name: 'KX0ABC', lat: 40, lon: -105 });
    expect(pts[0]?.meta.granularity).toBe('CITY');
  });

  it('drops SDRs the granularity blur nulled out', () => {
    const rows: RawSdrPublic[] = [
      {
        id: 'blurred',
        name: 'region only',
        latitude: null,
        longitude: null,
        locationGranularity: 'REGION',
      },
      { id: 'kept', name: 'has coords', latitude: 1, longitude: 1, locationGranularity: 'EXACT' },
    ];
    const pts = sdrsToPoints(rows);
    expect(pts.map((p) => p.id)).toEqual(['kept']);
  });

  it('normalizes an unknown granularity to null', () => {
    const rows: RawSdrPublic[] = [
      { id: 's', name: 'sdr', latitude: 1, longitude: 1, locationGranularity: 'BOGUS' },
    ];
    expect(sdrsToPoints(rows)[0]?.meta.granularity).toBeNull();
  });
});

describe('toMapPoints', () => {
  it('concatenates transmitter + SDR points, transmitters first', () => {
    const pts = toMapPoints(
      [{ id: 't', name: 'tx', latitude: 1, longitude: 1 }],
      [{ id: 's', name: 'sdr', latitude: 2, longitude: 2, locationGranularity: 'EXACT' }],
    );
    expect(pts.map((p) => p.type)).toEqual(['transmitter', 'sdr']);
  });
});

describe('formatFrequencies', () => {
  it('joins kHz values', () => {
    expect(formatFrequencies([11175, 8992])).toBe('11175 kHz, 8992 kHz');
  });
  it('returns a dash for empty / null', () => {
    expect(formatFrequencies(null)).toBe('—');
    expect(formatFrequencies([])).toBe('—');
  });
});

describe('granularityLabel', () => {
  it('maps each granularity', () => {
    expect(granularityLabel('EXACT')).toBe('exact location');
    expect(granularityLabel('CITY')).toContain('city');
    expect(granularityLabel('REGION')).toContain('region');
    expect(granularityLabel(null)).toBe('approximate location');
  });
});
