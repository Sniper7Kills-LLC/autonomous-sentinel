/**
 * Linguistic normalization stage (#495).
 *
 * The Linguistic Logic layer turns a raw transcript into a **log
 * format** — it does not store the transcript verbatim. This module
 * holds the pure, side-effect-free transforms that sit between the
 * rules-engine / AI-fallback capture step and `Message.create`:
 *
 *   - `decodePhonetic`        — "Alpha Charlie Delta" → "ACD"
 *   - `collapseDoubleBroadcast` — ALLSTATIONS / SKYKING are sent twice;
 *                                 emit the preamble + body once
 *   - `extractSender`         — "This is XXX out."  → "XXX"
 *   - `extractReceiver`       — "FOR XXXX FOR XXXX" → "XXXX"
 *   - `countCharacters`       — alphanumeric length of the decoded body
 *   - `normalizeParsed`       — per-type orchestrator
 *
 * Handler wiring (threading these into `processTranscript`) lands with
 * the pipeline-wiring issue #460; this module ships standalone with
 * full unit coverage so it can be reasoned about in isolation.
 *
 * NOT handled here (deferred — see #495 thread):
 *   - `codewordCount`: a flat transcript ("Alpha Charlie Delta") carries
 *     no group delimiters, so codeword grouping isn't recoverable
 *     without an owner grouping spec. Left out until that lands rather
 *     than baked in as a wrong guess.
 *   - SKYBIRD / SKYMASTER / RADIOCHECK canonical body formats (owed by
 *     owner) — those types pass through untransformed for now.
 */

/** NATO phonetic alphabet + digit words → alphanumeric. Keys are
 * normalized to lowercase alphanumerics so spelling/punctuation
 * variants ("Juliett", "X-ray", "Xray") collapse to one entry. */
const PHONETIC: Record<string, string> = {
  alpha: 'A',
  bravo: 'B',
  charlie: 'C',
  delta: 'D',
  echo: 'E',
  foxtrot: 'F',
  golf: 'G',
  hotel: 'H',
  india: 'I',
  juliet: 'J',
  juliett: 'J',
  kilo: 'K',
  lima: 'L',
  mike: 'M',
  november: 'N',
  oscar: 'O',
  papa: 'P',
  quebec: 'Q',
  romeo: 'R',
  sierra: 'S',
  tango: 'T',
  uniform: 'U',
  victor: 'V',
  whiskey: 'W',
  whisky: 'W',
  xray: 'X',
  yankee: 'Y',
  zulu: 'Z',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  niner: '9',
};

/** Lowercase + strip everything but [a-z0-9] so "X-ray," → "xray". */
function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whitespace-normalize: trim + collapse internal runs to a single space. */
function squish(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Decode a spoken NATO-phonetic letter/digit sequence to its
 * alphanumeric string. Non-phonetic tokens (preamble words, noise,
 * "uh"/"um") are dropped conservatively. Returns "" when there is no
 * phonetic content.
 */
export function decodePhonetic(spoken: string): string {
  if (typeof spoken !== 'string') return '';
  const out: string[] = [];
  for (const raw of spoken.split(/\s+/)) {
    const key = normalizeToken(raw);
    const decoded = key.length > 0 ? PHONETIC[key] : undefined;
    if (decoded) out.push(decoded);
  }
  return out.join('');
}

/** Minimum positional-token similarity for two halves to be judged a
 * repeat of the same broadcast (tolerates transcription variance). */
const COLLAPSE_SIMILARITY = 0.8;

/**
 * ALLSTATIONS and SKYKING are transmitted twice — the whole
 * preamble + body repeats back-to-back. Collapse a near-duplicate
 * second half so the parsed body lists the message once.
 *
 * Conservative by design: only collapses when the transcript splits
 * into two even halves whose positional token overlap meets
 * `COLLAPSE_SIMILARITY`. A single (non-duplicated) broadcast, an
 * odd token count, or two unrelated halves are returned unchanged so
 * a legitimately long transmission is never truncated.
 */
export function collapseDoubleBroadcast(text: string, opts: { delimiter?: boolean } = {}): string {
  const normalized = squish(text);
  if (!normalized) return normalized;

  // SKYKING marks its repeat with an explicit "I say again" delimiter —
  // reliable, no similarity guessing. Opt-in only: other double-broadcast
  // types (ALLSTATIONS) use the similarity path below and must not be
  // truncated by the phrase appearing in their content.
  if (opts.delimiter) {
    const sayAgain = /\bi say again\b/i.exec(normalized);
    if (sayAgain) {
      const head = normalized.slice(0, sayAgain.index).trim();
      if (head.length > 0) return head;
    }
  }

  const tokens = normalized.split(' ');
  const n = tokens.length;
  if (n < 2 || n % 2 !== 0) return normalized;

  const mid = n / 2;
  const first = tokens.slice(0, mid);
  const second = tokens.slice(mid);
  let matches = 0;
  for (let i = 0; i < mid; i++) {
    if (first[i] === second[i]) matches++;
  }
  if (matches / mid >= COLLAPSE_SIMILARITY) {
    return first.join(' ');
  }
  return normalized;
}

/**
 * Extract the sender from the "This is XXX out." sign-off. Returns the
 * callsign (which may be multiple words, e.g. "Cape Radio") or
 * undefined when the pattern is absent.
 */
export function extractSender(transcript: string): string | undefined {
  const m = /\bthis is\s+(.+?)\s+out\b/i.exec(transcript);
  const sender = m?.[1]?.trim();
  // Guard the degenerate "this is out out" — the lazy capture would
  // otherwise grab the sign-off word "out" as the callsign.
  if (!sender || /^out$/i.test(sender)) return undefined;
  return sender;
}

/**
 * Extract the receiver from the "FOR XXXX FOR XXXX" double-address.
 * The callsign is stated twice; the backreference confirms the repeat
 * and the single captured value is returned. Undefined when the
 * receiver is not stated twice.
 */
export function extractReceiver(transcript: string): string | undefined {
  const m = /\bfor\s+(\S+)\s+for\s+\1\b/i.exec(transcript);
  const receiver = m?.[1]?.trim();
  return receiver ? receiver : undefined;
}

/** Alphanumeric character count of a (decoded) body — whitespace ignored. */
export function countCharacters(body: string): number {
  return body.replace(/\s+/g, '').length;
}

export interface NormalizeInput {
  /** Message type from the rules engine / classifier. */
  type: string;
  /** Raw (or rules-engine-captured) transcript text. */
  transcript: string;
  /** Pre-captured fields from the rules engine — preferred when present. */
  sender?: string;
  receiver?: string;
  body?: string;
}

export interface NormalizeOutput {
  type: string;
  body?: string;
  sender?: string;
  receiver?: string;
  /** Set only for types with a decoded alphanumeric body (ALLSTATIONS). */
  characterCount?: number;
  /** Set for SKYKING — always 1 per owner spec. */
  codewordCount?: number;
}

/** Types broadcast twice on air — eligible for double-broadcast collapse. */
const DOUBLE_BROADCAST_TYPES = new Set(['ALLSTATIONS', 'SKYKING']);

/**
 * Per-type normalization orchestrator. Captured fields (from the rules
 * engine) win over re-extraction; extraction is the fallback when a
 * field wasn't captured.
 *
 * - ALLSTATIONS: collapse → decode body to alphanumeric → char count.
 * - SKYKING: collapse (via "I say again") → body kept inline (TIME/AUTH
 *   stay in the text, no decode) → codewordCount = 1. Sender + receiver
 *   are both extracted (a SKYKING may carry either).
 * - everything else: passthrough (trimmed body, best-effort extraction).
 */
export function normalizeParsed(input: NormalizeInput): NormalizeOutput {
  const collapsed =
    input.type === 'SKYKING'
      ? // SKYKING uses the explicit "I say again" delimiter (similarity
        // fallback still applies when the delimiter is absent).
        collapseDoubleBroadcast(input.transcript, { delimiter: true })
      : DOUBLE_BROADCAST_TYPES.has(input.type)
        ? collapseDoubleBroadcast(input.transcript)
        : squish(input.transcript);

  const sender = input.sender ?? extractSender(collapsed);
  const receiver = input.receiver ?? extractReceiver(collapsed);

  if (input.type === 'ALLSTATIONS') {
    const body = decodePhonetic(input.body ?? collapsed);
    return {
      type: input.type,
      body,
      sender,
      receiver,
      characterCount: countCharacters(body),
    };
  }

  if (input.type === 'SKYKING') {
    // Body kept inline (CODEWORD + TIME + AUTH); repeat already dropped
    // by the "I say again" collapse. codewordCount is always 1.
    return {
      type: input.type,
      body: input.body ? squish(input.body) : collapsed,
      sender,
      receiver,
      codewordCount: 1,
    };
  }

  // All other types: keep the (collapsed) text as the body, no decode.
  return {
    type: input.type,
    body: input.body ? squish(input.body) : collapsed,
    sender,
    receiver,
  };
}
