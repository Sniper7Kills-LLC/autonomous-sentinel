import { describe, it, expect, vi } from 'vitest';
import {
  parseLatestSfi,
  parseLatestKp,
  propagationBand,
  fetchSpaceWeather,
  formatUtcHHMM,
  spaceWeatherSummary,
  type SpaceWeather,
  SFI_URL,
  KP_URL,
} from './noaa';
import { contrastRatio, AA_BODY } from '@/lib/a11y/contrast';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('parseLatestSfi', () => {
  it('returns null for an empty array', () => {
    expect(parseLatestSfi([])).toBeNull();
  });

  it('returns null for a malformed (non-array) payload', () => {
    expect(parseLatestSfi(null)).toBeNull();
    expect(parseLatestSfi({ flux: 123 })).toBeNull();
    expect(parseLatestSfi('nope')).toBeNull();
  });

  it('picks the latest row by timestamp, not array order', () => {
    const payload = [
      { time_tag: '2026-05-30T00:00:00', flux: 100 },
      { time_tag: '2026-06-01T00:00:00', flux: 142 },
      { time_tag: '2026-05-31T00:00:00', flux: 120 },
    ];
    expect(parseLatestSfi(payload)).toBe(142);
  });

  it('coerces numeric strings', () => {
    expect(parseLatestSfi([{ time_tag: '2026-06-01T00:00:00', flux: '155.5' }])).toBe(155.5);
  });

  it('falls back to the last element when no row has a parseable time', () => {
    expect(parseLatestSfi([{ flux: 90 }, { flux: 95 }])).toBe(95);
  });

  it('returns null when the flux field is missing', () => {
    expect(parseLatestSfi([{ time_tag: '2026-06-01T00:00:00' }])).toBeNull();
  });
});

describe('parseLatestKp', () => {
  it('returns null for an empty array', () => {
    expect(parseLatestKp([])).toBeNull();
  });

  it('reads kp_index', () => {
    expect(parseLatestKp([{ time_tag: '2026-06-01T00:00:00', kp_index: 3 }])).toBe(3);
  });

  it('reads estimated_kp when kp_index is absent', () => {
    expect(parseLatestKp([{ time_tag: '2026-06-01T00:00:00', estimated_kp: 4.33 }])).toBe(4.33);
  });

  it('picks the latest row by timestamp', () => {
    const payload = [
      { time_tag: '2026-06-01T00:00:00', kp_index: 2 },
      { time_tag: '2026-06-01T00:10:00', kp_index: 6 },
      { time_tag: '2026-06-01T00:05:00', kp_index: 4 },
    ];
    expect(parseLatestKp(payload)).toBe(6);
  });

  it('returns null for malformed payloads', () => {
    expect(parseLatestKp(undefined)).toBeNull();
    expect(parseLatestKp(42)).toBeNull();
  });
});

describe('propagationBand', () => {
  it('returns the unknown band (gray) when Kp is missing', () => {
    const band = propagationBand(150, null);
    expect(band.color).toBe('#7a8088');
    expect(band.description).toMatch(/unavailable/i);
  });

  it('classifies Quiet below Kp 3 with healthy flux', () => {
    expect(propagationBand(150, 2).name).toBe('Quiet');
    expect(propagationBand(150, 0).name).toBe('Quiet');
  });

  it('nudges a quiet field to Unsettled when SFI is low (< 70)', () => {
    expect(propagationBand(68, 1).name).toBe('Unsettled');
    expect(propagationBand(70, 1).name).toBe('Quiet');
  });

  it('classifies Unsettled at 3 ≤ Kp < 4', () => {
    expect(propagationBand(150, 3).name).toBe('Unsettled');
    expect(propagationBand(150, 3.9).name).toBe('Unsettled');
  });

  it('classifies Active at 4 ≤ Kp < 5', () => {
    expect(propagationBand(150, 4).name).toBe('Active');
    expect(propagationBand(150, 4.9).name).toBe('Active');
  });

  it('classifies Storm at Kp ≥ 5', () => {
    expect(propagationBand(150, 5).name).toBe('Storm');
    expect(propagationBand(150, 9).name).toBe('Storm');
  });

  it('returns distinct colors per named band', () => {
    const names = [
      propagationBand(150, 1),
      propagationBand(150, 3),
      propagationBand(150, 4),
      propagationBand(150, 6),
    ];
    const colors = new Set(names.map((b) => b.color));
    expect(colors.size).toBe(4);
  });

  it('every band text/background pair clears WCAG AA 4.5:1', () => {
    // Cover all five band objects (the four Kp bands + the unknown band).
    const bands = [
      propagationBand(150, 1), // Quiet
      propagationBand(150, 3), // Unsettled
      propagationBand(150, 4), // Active
      propagationBand(150, 6), // Storm
      propagationBand(150, null), // Unknown
    ];
    for (const band of bands) {
      expect(contrastRatio(band.textColor, band.color)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });
});

describe('fetchSpaceWeather', () => {
  it('fetches both feeds and classifies a band', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url === SFI_URL)
        return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', flux: 142 }]));
      if (url === KP_URL)
        return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', kp_index: 2 }]));
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    const sw = await fetchSpaceWeather(fetchImpl, () => 1000);
    expect(sw.sfi).toBe(142);
    expect(sw.kp).toBe(2);
    expect(sw.band.name).toBe('Quiet');
    expect(sw.fetchedAt).toBe(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('yields a partial reading when one feed fails', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url === SFI_URL)
        return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', flux: 142 }]));
      return Promise.reject(new Error('kp feed down'));
    });
    const sw = await fetchSpaceWeather(fetchImpl, () => 2000);
    expect(sw.sfi).toBe(142);
    expect(sw.kp).toBeNull();
    // Kp unknown → unknown band
    expect(sw.band.color).toBe('#7a8088');
  });

  it('throws when both feeds fail', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network down')));
    await expect(fetchSpaceWeather(fetchImpl)).rejects.toThrow(/NOAA space-weather fetch failed/);
  });

  it('treats a non-ok HTTP response as a feed failure', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url === SFI_URL)
        return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', flux: 99 }]));
      return Promise.resolve(jsonResponse(null, false, 503));
    });
    const sw = await fetchSpaceWeather(fetchImpl, () => 3000);
    expect(sw.sfi).toBe(99);
    expect(sw.kp).toBeNull();
  });
});

describe('formatUtcHHMM', () => {
  it('formats epoch ms as zero-padded UTC HH:MM', () => {
    expect(formatUtcHHMM(Date.UTC(2026, 5, 1, 4, 7))).toBe('04:07');
    expect(formatUtcHHMM(Date.UTC(2026, 5, 1, 23, 59))).toBe('23:59');
  });
});

describe('spaceWeatherSummary', () => {
  const reading: SpaceWeather = {
    sfi: 142,
    kp: 2,
    band: propagationBand(142, 2),
    fetchedAt: Date.UTC(2026, 5, 1, 8, 30),
  };

  it('reports unavailable when there is no reading', () => {
    expect(spaceWeatherSummary(null, false)).toMatch(/unavailable/i);
  });

  it('summarizes SFI, Kp, and band in plain text', () => {
    const s = spaceWeatherSummary(reading, false);
    expect(s).toContain('142');
    expect(s).toContain('K-index 2');
    expect(s).toContain('Quiet');
    expect(s).not.toMatch(/stale/i);
  });

  it('renders dashes for missing values', () => {
    const partial: SpaceWeather = { ...reading, kp: null, band: propagationBand(142, null) };
    expect(spaceWeatherSummary(partial, false)).toContain('K-index —');
  });

  it('appends a stale UTC note when stale', () => {
    expect(spaceWeatherSummary(reading, true)).toMatch(/stale, fetched 08:30 UTC/);
  });
});
