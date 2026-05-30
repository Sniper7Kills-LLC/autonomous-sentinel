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
 *   - `normalizeParsed`       — per-type orchestrator
 *
 * Field extraction (sender / receiver) is deliberately NOT done here.
 * Per owner spec (#552): hard-coded rules determine the message TYPE
 * only; every field is supplied by an AI-generated `LinguisticRule` or
 * a live Bedrock parse. This module never invents sender/receiver from
 * the transcript — it only passes through already-captured fields and
 * formats the body.
 *
 * Handler wiring (threading these into `processTranscript`) lands with
 * the pipeline-wiring issue #460; this module ships standalone with
 * full unit coverage so it can be reasoned about in isolation.
 *
 * NOT handled here:
 *   - `characterCount` / `codewordCount` are NOT per-message outputs of
 *     this stage — they are aggregate CHART values over the whole corpus
 *     (owner, 2026-05-28): `characterCount` = how many times each decoded
 *     character appears across all ALLSTATIONS messages; `codewordCount`
 *     = how many times a specific codeword was used across the database.
 *     Both belong to the charts/analytics layer, not the normalizer.
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
/** Max fragments whisper splits one NATO word into (e.g. "fo xt rot"). */
const MAX_JOIN = 3;

export function decodePhonetic(spoken: string): string {
  if (typeof spoken !== 'string') return '';
  // Whisper frequently splits a single phonetic word across tokens
  // ("brav o", "x - ray", "fo xt rot", "z ulu", "y an kee") and inserts
  // punctuation. Normalize each token to [a-z0-9], drop empties, then
  // greedily match the longest run of 1..MAX_JOIN adjacent fragments
  // against the NATO table. Longest-first so a clean "alpha charlie"
  // still decodes letter-by-letter; unmatched fragments are noise → drop.
  const toks = spoken
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    let matched = false;
    for (let k = Math.min(MAX_JOIN, toks.length - i); k >= 1; k--) {
      const decoded = PHONETIC[toks.slice(i, i + k).join('')];
      if (decoded) {
        out.push(decoded);
        i += k;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
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
}

/** Types broadcast twice on air — eligible for double-broadcast collapse. */
const DOUBLE_BROADCAST_TYPES = new Set(['ALLSTATIONS', 'SKYKING']);

/**
 * Per-type normalization orchestrator. Sender / receiver are taken
 * verbatim from the captured fields (AI-generated rule or Bedrock parse)
 * — there is no transcript-derived extraction fallback (#552).
 *
 * - ALLSTATIONS: collapse → decode body to alphanumeric.
 * - SKYKING: collapse (via "I say again") → body kept inline (TIME/AUTH
 *   stay in the text, no decode).
 * - everything else: passthrough (trimmed body).
 *
 * Note: characterCount / codewordCount are NOT produced here — they are
 * aggregate chart values computed over the corpus (see header).
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

  // Fields come only from captured input (AI rule / Bedrock parse).
  const sender = input.sender;
  const receiver = input.receiver;

  if (input.type === 'ALLSTATIONS') {
    // Decode-if-phonetic-else-trust (#559): a raw phonetic body decodes to
    // its alphanumeric group; an already-decoded body (the AI returns the
    // body decoded per the fallback prompt) yields "" from decodePhonetic —
    // fall back to the captured body itself rather than collapsing to "",
    // which upstream turns into the raw transcript.
    const captured = input.body ?? collapsed;
    return {
      type: input.type,
      body: decodePhonetic(captured) || squish(captured),
      sender,
      receiver,
    };
  }

  if (input.type === 'SKYKING') {
    // Body kept inline (CODEWORD + TIME + AUTH); repeat already dropped
    // by the "I say again" collapse.
    return {
      type: input.type,
      body: input.body ? squish(input.body) : collapsed,
      sender,
      receiver,
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
