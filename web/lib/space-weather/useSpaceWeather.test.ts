import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpaceWeather } from './useSpaceWeather';
import { SFI_URL, KP_URL } from './noaa';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function okFetch(flux: number, kp: number) {
  return vi.fn((url: string) => {
    if (url === SFI_URL)
      return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', flux }]));
    if (url === KP_URL)
      return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', kp_index: kp }]));
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('useSpaceWeather', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not fetch while disabled', () => {
    const fetchImpl = okFetch(142, 2);
    renderHook(() => useSpaceWeather({ enabled: false, fetchImpl }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches once enabled and exposes the reading', async () => {
    const fetchImpl = okFetch(142, 2);
    const { result } = renderHook(() => useSpaceWeather({ enabled: true, fetchImpl }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.sfi).toBe(142);
    expect(result.current.data?.kp).toBe(2);
    expect(result.current.stale).toBe(false);
  });

  it('keeps last-known data and flags stale when a later fetch fails', async () => {
    let calls = 0;
    const fetchImpl = vi.fn((url: string) => {
      calls++;
      if (calls > 2) return Promise.reject(new Error('down')); // first cycle ok, then fail
      if (url === SFI_URL)
        return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', flux: 142 }]));
      return Promise.resolve(jsonResponse([{ time_tag: '2026-06-01T00:00:00', kp_index: 2 }]));
    });
    const { result } = renderHook(() =>
      useSpaceWeather({ enabled: true, fetchImpl, refreshMs: 1000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.sfi).toBe(142);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Data retained, flagged stale.
    expect(result.current.data?.sfi).toBe(142);
    expect(result.current.stale).toBe(true);
  });

  it('stops fetching after unmount', async () => {
    const fetchImpl = okFetch(142, 2);
    const { unmount, result } = renderHook(() =>
      useSpaceWeather({ enabled: true, fetchImpl, refreshMs: 1000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.sfi).toBe(142);
    const before = fetchImpl.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchImpl.mock.calls.length).toBe(before);
  });
});
