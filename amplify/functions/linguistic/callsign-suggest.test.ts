import { describe, it, expect, vi } from 'vitest';
import {
  normalizeCallsign,
  callsignCandidates,
  loadApprovedCallsigns,
  suggestCallsigns,
  type CallsignClient,
} from './callsign-suggest';

function makeClient(
  existing: Array<{ id: string; normalized?: string | null; variants?: string[] | null }> = [],
  opts: { listErrors?: boolean; createErrors?: boolean } = {},
): {
  client: CallsignClient;
  listSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn().mockResolvedValue({
    data: opts.listErrors ? null : existing,
    errors: opts.listErrors ? [{ message: 'boom' }] : null,
  });
  const createSpy = vi.fn().mockResolvedValue({
    data: opts.createErrors ? null : { id: 'new' },
    errors: opts.createErrors ? [{ message: 'denied' }] : null,
  });
  return {
    client: { models: { Callsign: { list: listSpy as never, create: createSpy as never } } },
    listSpy,
    createSpy,
  };
}

describe('normalizeCallsign / callsignCandidates (#776)', () => {
  it('uppercases + trims', () => {
    expect(normalizeCallsign('  mainsail ')).toBe('MAINSAIL');
    expect(normalizeCallsign(null)).toBe('');
  });

  it('drops empties, collective receivers, and dedups', () => {
    expect(callsignCandidates('Mainsail', 'ALL STATIONS')).toEqual(['MAINSAIL']);
    expect(callsignCandidates('SKYKING', 'skyking')).toEqual(['SKYKING']);
    expect(callsignCandidates(null, '')).toEqual([]);
  });
});

describe('loadApprovedCallsigns (#778)', () => {
  it('returns normalized approved entries, sorted, filtering by approved', async () => {
    const { client, listSpy } = makeClient([
      { id: '1', normalized: 'Mainsail' },
      { id: '2', normalized: 'ANDREWS' },
    ]);
    const out = await loadApprovedCallsigns(client);
    expect(listSpy).toHaveBeenCalledWith({ filter: { approved: { eq: true } }, limit: 1000 });
    expect(out).toEqual(['ANDREWS', 'MAINSAIL']);
  });

  it('returns [] on a list error (best-effort)', async () => {
    const { client } = makeClient([], { listErrors: true });
    expect(await loadApprovedCallsigns(client)).toEqual([]);
  });
});

describe('suggestCallsigns (#776)', () => {
  it('creates AI_SUGGESTED/approved=false rows only for unknown callsigns', async () => {
    const { client, createSpy } = makeClient([{ id: '1', normalized: 'MAINSAIL' }]);
    const created = await suggestCallsigns(client, ['MAINSAIL', 'ANDREWS']);
    expect(created).toEqual(['ANDREWS']);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ normalized: 'ANDREWS', source: 'AI_SUGGESTED', approved: false }),
    );
  });

  it('matches existing variants (case-insensitive) and skips them', async () => {
    const { client, createSpy } = makeClient([
      { id: '1', normalized: 'SKYKING', variants: ['Sky King'] },
    ]);
    const created = await suggestCallsigns(client, ['SKY KING']);
    expect(created).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('does not double-create a repeated candidate within one batch', async () => {
    const { client, createSpy } = makeClient([]);
    const created = await suggestCallsigns(client, ['ANDREWS', 'ANDREWS']);
    expect(created).toEqual(['ANDREWS']);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: list error → no creates, returns []', async () => {
    const { client, createSpy } = makeClient([], { listErrors: true });
    expect(await suggestCallsigns(client, ['ANDREWS'])).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('skips a candidate whose create errors, without throwing', async () => {
    const { client } = makeClient([], { createErrors: true });
    expect(await suggestCallsigns(client, ['ANDREWS'])).toEqual([]);
  });
});
