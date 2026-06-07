/**
 * Callsign dictionary suggestion + priming helpers (#776 / #778).
 *
 * The linguistic pipeline extracts a sender/receiver on every parse. This
 * module:
 *   - normalizes a callsign the same way the admin editor does
 *     (`trim().toUpperCase()`),
 *   - filters out non-callsign receivers (ALL STATIONS) + empties,
 *   - on a parse, suggests any callsign NOT already in the dictionary as an
 *     `AI_SUGGESTED`, `approved=false` row for admin confirm/reject (#777),
 *   - and exposes the approved set for prompt priming (#778).
 *
 * Pure-ish: the I/O functions take the narrow data-client surface so the
 * handler stays best-effort (a dictionary hiccup never blocks publish).
 */

/** Narrow Callsign data surface (mirrors LinguisticDataClient.models.Callsign). */
export interface CallsignClient {
  models: {
    Callsign: {
      list: (input?: Record<string, unknown>) => Promise<{
        data: Array<{ id: string; normalized?: string | null; variants?: string[] | null }> | null;
        errors?: unknown;
      }>;
      create: (input: {
        normalized: string;
        source: 'LEGACY' | 'ADMIN' | 'AI_SUGGESTED';
        approved: boolean;
        confidence?: number | null;
        notes?: string | null;
      }) => Promise<{ data: { id?: string } | null; errors?: unknown }>;
    };
  };
}

/** Receivers that are NOT callsigns — never suggest these. */
const NON_CALLSIGN = new Set(['ALL STATIONS', 'ALLSTATIONS', 'ALL STATION']);

/** Normalize a callsign the same way the admin editor does. */
export function normalizeCallsign(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/**
 * Distinct, normalized callsign candidates worth dictionary-checking from a
 * parse's sender + receiver. Drops empties + collective receivers.
 */
export function callsignCandidates(
  sender: string | null | undefined,
  receiver: string | null | undefined,
): string[] {
  const out: string[] = [];
  for (const raw of [sender, receiver]) {
    const n = normalizeCallsign(raw);
    if (!n || NON_CALLSIGN.has(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Load the approved dictionary entries (normalized strings) for priming (#778). */
export async function loadApprovedCallsigns(client: CallsignClient): Promise<string[]> {
  const res = await client.models.Callsign.list({
    filter: { approved: { eq: true } },
    limit: 1000,
  });
  if (res.errors) return [];
  const set = new Set<string>();
  for (const r of res.data ?? []) {
    const n = normalizeCallsign(r.normalized);
    if (n) set.add(n);
  }
  return [...set].sort();
}

/**
 * Suggest any candidate callsign not already in the dictionary (#776).
 * Best-effort: never throws. Returns the normalized callsigns it created.
 *
 * Dedup: matches an existing row's `normalized` OR any of its `variants`
 * (case-insensitive). Existing pending suggestions are not re-created.
 */
export async function suggestCallsigns(
  client: CallsignClient,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  let known: Set<string>;
  try {
    const res = await client.models.Callsign.list({ limit: 1000 });
    if (res.errors) return [];
    known = new Set<string>();
    for (const r of res.data ?? []) {
      const n = normalizeCallsign(r.normalized);
      if (n) known.add(n);
      for (const v of r.variants ?? []) {
        const nv = normalizeCallsign(v);
        if (nv) known.add(nv);
      }
    }
  } catch {
    return [];
  }

  const created: string[] = [];
  for (const c of candidates) {
    if (known.has(c)) continue;
    try {
      const res = await client.models.Callsign.create({
        normalized: c,
        source: 'AI_SUGGESTED',
        approved: false,
        confidence: null,
        notes: 'Auto-suggested from a linguistic parse (#776)',
      });
      if (!res.errors) {
        created.push(c);
        // Guard against a duplicate suggestion within the same batch.
        known.add(c);
      }
    } catch {
      // Best-effort — skip on a single create failure.
    }
  }
  return created;
}
