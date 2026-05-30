import { createHash } from 'node:crypto';

/**
 * Amazon Transcribe custom-vocabulary helpers (#56, #585 refinement).
 *
 * The (c) backend in CLAUDE.md → Pipeline components → Transcribe
 * Lambda. Transcribe accepts a per-language custom vocabulary uploaded
 * once + referenced by name on every job. The vocab name embeds a hash
 * of the term set so it stays stable while the inputs are unchanged
 * (jobs don't pay the upload cost per recording); changing any input
 * rolls the name so a fresh vocab is created + jobs route to it without
 * an in-place update race.
 *
 * VOCAB FORMAT — **table** (`VocabularyFileUri`), not list (`Phrases`).
 * The EAM body is read in NATO phonetics + military digit words +
 * multi-word prowords ("do not answer", "i say again", …) — exactly
 * what generic ASR mangles. Single-word terms work in either format,
 * but multi-word prowords need the table format: the `Phrase` column
 * joins the words with hyphens (`do-not-answer`) and `DisplayAs`
 * renders them back with spaces. So we emit a TSV table (header
 * `Phrase<TAB>DisplayAs`), upload it to S3, and create the vocab from
 * `VocabularyFileUri`. The handler owns the S3 upload; this module is
 * pure (builds the table + TSV + hash).
 *
 * Term set = `BASE_VOCAB` (single words) ∪ `BASE_PROWORDS` (multi-word
 * phrases) ∪ dynamic callsigns, all folded into the hash so the vocab
 * rolls when any of the three changes.
 *
 * Vocab name format: `eam-callsigns-<12-char-hex-prefix>`.
 *   - `eam-callsigns-` is the project namespace.
 *   - 12 hex chars (48 bits) — ample for a hand-curated set that rolls
 *     a handful of times per year.
 *   - Total length ≤ 27 chars; within Transcribe's 200-char name limit.
 *
 * Normalisation (before hashing): trim, uppercase the Phrase token,
 * drop empties, dedupe by Phrase, sort — order-independent hash.
 */

export const VOCAB_NAME_PREFIX = 'eam-callsigns-';
export const VOCAB_HASH_LENGTH = 12;

/**
 * One row of the Transcribe custom-vocabulary table.
 *   - `phrase`    — the `Phrase` column: a single hyphen-joined token
 *                   (Transcribe forbids spaces here). Uppercased.
 *   - `displayAs` — the `DisplayAs` column: how the term renders in the
 *                   transcript. Only set for multi-word prowords (so
 *                   `more-to-follow` renders as `more to follow`);
 *                   omitted for single words (Transcribe defaults
 *                   DisplayAs to the Phrase).
 */
export interface VocabRow {
  phrase: string;
  displayAs?: string;
}

/**
 * Static single-word base vocabulary (#585). NATO phonetic alphabet +
 * military digit words + collective callsigns. Biasing Transcribe
 * toward these is the highest-value part of the custom vocab; the
 * dynamic callsign list is additive on top.
 *
 * Pre-uppercased for readability; the builder re-canonicalises anyway.
 */
export const BASE_VOCAB: readonly string[] = [
  // NATO phonetic alphabet (ALFA / JULIETT per ICAO/military; ALPHA
  // included as the common variant).
  'ALFA',
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
  'INDIA',
  'JULIETT',
  'KILO',
  'LIMA',
  'MIKE',
  'NOVEMBER',
  'OSCAR',
  'PAPA',
  'QUEBEC',
  'ROMEO',
  'SIERRA',
  'TANGO',
  'UNIFORM',
  'VICTOR',
  'WHISKEY',
  'XRAY',
  'YANKEE',
  'ZULU',
  // Military digit words (radiotelephony: TREE / FOWER / FIFE / NINER)
  // plus the standard spellings ASR is likelier to emit (NINE, TWO).
  'ZERO',
  'ONE',
  'TWO',
  'TREE',
  'FOWER',
  'FIFE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINER',
  'NINE',
  // Collective callsigns seen on every EAM net.
  'SKYKING',
  'MAINSAIL',
  'SKYBIRD',
  'SKYMASTER',
  'ALLSTATIONS',
  // Single-word prowords (table-format Phrase == DisplayAs, so no
  // DisplayAs row needed — these live here rather than in
  // BASE_PROWORDS).
  'AUTHENTICATION',
  'DISREGARD',
  'BREAK',
  'CORRECTION',
  'TIME',
  'OUT',
  'OVER',
  'STANDBY',
];

/**
 * Static multi-word EAM prowords (#585). Table-format rows: `phrase`
 * is the hyphen-joined token Transcribe biases toward, `displayAs` is
 * the spaced rendering it writes into the transcript. The chunker (#59)
 * keys off some of these ("more to follow"), and the Linguistic Logic
 * rules match the spaced forms, so accurate ASR of them is high-value.
 */
export const BASE_PROWORDS: readonly Required<VocabRow>[] = [
  { phrase: 'do-not-answer', displayAs: 'do not answer' },
  { phrase: 'i-say-again', displayAs: 'i say again' },
  { phrase: 'message-follows', displayAs: 'message follows' },
  { phrase: 'stand-by', displayAs: 'stand by' },
  { phrase: 'test-count', displayAs: 'test count' },
  { phrase: 'radio-check', displayAs: 'radio check' },
  { phrase: 'all-stations', displayAs: 'all stations' },
  { phrase: 'more-to-follow', displayAs: 'more to follow' },
];

export interface VocabHash {
  /** SHA-256 hex digest of the canonicalised term table. */
  full: string;
  /** First `VOCAB_HASH_LENGTH` chars of `full` — embedded in the vocab name. */
  short: string;
  /** Final vocab name passed to Transcribe: `eam-callsigns-<short>`. */
  vocabName: string;
  /**
   * Sorted, deduped list of `Phrase`-column values the hash covers —
   * the union of BASE_VOCAB phrases, BASE_PROWORDS phrases, and the
   * dynamic callsigns. Kept for assertions + the GetVocabulary/skip
   * decision (length 0 ⇒ nothing to upload).
   */
  canonicalised: string[];
  /** Full table rows (Phrase + optional DisplayAs) backing the TSV. */
  rows: VocabRow[];
  /** The TSV table-format body to upload to S3 for `VocabularyFileUri`. */
  tableTsv: string;
}

/**
 * Canonicalises a raw callsign list (trim / uppercase the Phrase token
 * / drop empty / dedupe / sort). Spaces in a free-form callsign collapse
 * to hyphens so the value is a valid single-token `Phrase`. Exposed for
 * tests + reuse.
 */
export function canonicaliseCallsigns(callsigns: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const raw of callsigns) {
    if (typeof raw !== 'string') continue;
    const norm = raw.trim().toUpperCase().replace(/\s+/g, '-');
    if (norm.length === 0) continue;
    seen.add(norm);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Builds the full Transcribe vocabulary table: BASE_VOCAB single words
 * ∪ BASE_PROWORDS phrases ∪ dynamic callsigns. Deduped by `phrase`
 * (a callsign that collides with a base phrase keeps the base row's
 * DisplayAs), sorted by `phrase` for an order-independent hash.
 *
 * Folding everything in here means a change to ANY of the three inputs
 * rolls the hash, and an empty callsign list still yields a non-empty
 * table (base + prowords alone).
 */
export function buildVocabTable(callsigns: readonly (string | null | undefined)[]): VocabRow[] {
  const byPhrase = new Map<string, VocabRow>();
  // Base single words first (Phrase only).
  for (const phrase of canonicaliseCallsigns(BASE_VOCAB)) {
    byPhrase.set(phrase, { phrase });
  }
  // Multi-word prowords (Phrase + DisplayAs). Phrase tokens are
  // lowercase-hyphen by convention but canonicalise to uppercase so a
  // base single word and a proword phrase can't silently diverge in
  // case; DisplayAs preserves the human spelling verbatim.
  for (const row of BASE_PROWORDS) {
    const phrase = row.phrase.trim().toUpperCase().replace(/\s+/g, '-');
    if (phrase.length === 0) continue;
    byPhrase.set(phrase, { phrase, displayAs: row.displayAs });
  }
  // Dynamic callsigns last; never overwrite a base/proword row.
  for (const phrase of canonicaliseCallsigns(callsigns)) {
    if (!byPhrase.has(phrase)) byPhrase.set(phrase, { phrase });
  }
  return [...byPhrase.values()].sort((a, b) =>
    a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0,
  );
}

/**
 * Strips the TSV structural characters (`\t`, `\n`, `\r`) from a cell
 * value, replacing each run with a single space and trimming. Defends
 * the serialisation boundary against TSV injection: a callsign /
 * DisplayAs carrying a tab or newline would otherwise split a logical
 * term across multiple TSV columns / rows and corrupt the whole table.
 * Upstream canonicalisation already collapses whitespace in the Phrase
 * token, but this guards every cell unconditionally.
 */
function sanitiseTsvCell(value: string): string {
  return value
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Serialises vocab rows to the Transcribe table-format TSV body:
 * a `Phrase<TAB>DisplayAs` header followed by one tab-separated row
 * per term. A row with no DisplayAs leaves that cell empty (Transcribe
 * then renders the Phrase verbatim — fine for single words). Every cell
 * is sanitised so no Phrase / DisplayAs value can inject a stray tab or
 * newline and break the one-row-per-term structure.
 */
export function buildVocabTableTsv(rows: readonly VocabRow[]): string {
  const lines = ['Phrase\tDisplayAs'];
  for (const r of rows) {
    lines.push(`${sanitiseTsvCell(r.phrase)}\t${sanitiseTsvCell(r.displayAs ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @deprecated kept for callers that only need the Phrase list. Prefer
 * `buildVocabTable`. Returns the sorted, deduped `Phrase` values of the
 * full table (base ∪ prowords ∪ callsigns).
 */
export function unionWithBaseVocab(callsigns: readonly (string | null | undefined)[]): string[] {
  return buildVocabTable(callsigns).map((r) => r.phrase);
}

/**
 * Deterministic SHA-256 hash of the canonicalised term table + derived
 * vocab name + TSV body. Identical inputs produce identical hashes
 * regardless of original order / whitespace / case. The hash covers
 * BOTH the Phrase and DisplayAs columns so editing a proword's rendered
 * spelling also rolls the vocab.
 */
export function computeVocabHash(callsigns: readonly (string | null | undefined)[]): VocabHash {
  const rows = buildVocabTable(callsigns);
  const tableTsv = buildVocabTableTsv(rows);
  // Hash the TSV body directly — it is the canonical, order-stable
  // serialisation of every Phrase + DisplayAs cell.
  const full = createHash('sha256').update(tableTsv, 'utf8').digest('hex');
  const short = full.slice(0, VOCAB_HASH_LENGTH);
  return {
    full,
    short,
    vocabName: `${VOCAB_NAME_PREFIX}${short}`,
    canonicalised: rows.map((r) => r.phrase),
    rows,
    tableTsv,
  };
}

/**
 * Returns true when the new callsign list produces a different vocab
 * hash than the cached one — i.e. a fresh `CreateVocabulary` against
 * the new hash-derived name is needed. Compares on `full` not `short`
 * so a truncation collision can't suppress an update.
 */
export function vocabChanged(prevHashFull: string | null | undefined, next: VocabHash): boolean {
  if (typeof prevHashFull !== 'string') return true;
  if (prevHashFull.length === 0) return true;
  return prevHashFull !== next.full;
}
