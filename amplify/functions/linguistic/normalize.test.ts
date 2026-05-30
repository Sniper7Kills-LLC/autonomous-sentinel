import { describe, it, expect } from 'vitest';

import { decodePhonetic, collapseDoubleBroadcast, normalizeParsed } from './normalize';

/**
 * Linguistic normalization stage (#495).
 *
 * Pure functions that turn a raw transcript (and the rules-engine /
 * AI-fallback captured fields) into the log-format Message fields:
 * decoded alphanumeric body and de-duplicated double broadcast. Sender /
 * receiver are NOT extracted here — per #552 the AI owns all field
 * extraction; this module only passes captured fields through. No DDB,
 * no network.
 */

describe('normalize — decodePhonetic', () => {
  it('decodes a NATO phonetic letter group to alphanumeric', () => {
    expect(decodePhonetic('Alpha Charlie Delta')).toBe('ACD');
  });

  it('decodes digits, including "niner"', () => {
    expect(decodePhonetic('Niner Five Zero')).toBe('950');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(decodePhonetic('alpha, CHARLIE. delta!')).toBe('ACD');
  });

  it('handles spelling variants (Juliett, X-ray, Xray)', () => {
    expect(decodePhonetic('Juliett Xray X-ray Juliet')).toBe('JXXJ');
  });

  it('drops non-phonetic noise tokens conservatively', () => {
    expect(decodePhonetic('uh Alpha um Bravo')).toBe('AB');
  });

  it('returns empty string for no phonetic content', () => {
    expect(decodePhonetic('hello world')).toBe('');
  });

  it('joins whisper-split NATO words (#521)', () => {
    expect(decodePhonetic('brav o')).toBe('B');
    expect(decodePhonetic('x - ray')).toBe('X');
    expect(decodePhonetic('fo xt rot')).toBe('F');
    expect(decodePhonetic('z ulu')).toBe('Z');
    expect(decodePhonetic('pap a')).toBe('P');
    expect(decodePhonetic('vict or')).toBe('V');
    expect(decodePhonetic('y an kee')).toBe('Y');
  });

  it('decodes a real split-token whisper sequence', () => {
    // From recording 6b11cd4b: "mic , pap a , brav o , mic , delta , uniform"
    // ("mic" is a whisper mishear of "mike", not a split — dropped).
    expect(decodePhonetic('pap a , brav o , delta , uniform')).toBe('PBDU');
  });

  it('still decodes clean letter-by-letter input (no over-join)', () => {
    expect(decodePhonetic('Alpha Charlie Delta')).toBe('ACD');
    expect(decodePhonetic('India India Alpha')).toBe('IIA');
  });
});

describe('normalize — collapseDoubleBroadcast', () => {
  it('collapses an exact double broadcast to a single copy', () => {
    const once = 'all stations all stations alpha charlie delta';
    expect(collapseDoubleBroadcast(`${once} ${once}`)).toBe(once);
  });

  it('collapses a near-duplicate second half (transcription variance)', () => {
    const a = 'all stations all stations alpha charlie delta echo';
    const b = 'all stations all stations alpha charlie delta eko'; // 1 token differs
    expect(collapseDoubleBroadcast(`${a} ${b}`)).toBe(a);
  });

  it('normalizes whitespace', () => {
    const once = 'alpha charlie delta';
    expect(collapseDoubleBroadcast(`  ${once}   ${once}  `)).toBe(once);
  });

  it('does NOT truncate a single, non-duplicated broadcast', () => {
    const single = 'skybird this is offutt with a long unique transmission for andrews out';
    expect(collapseDoubleBroadcast(single)).toBe(single);
  });

  it('does NOT collapse when the two halves are unrelated', () => {
    const text = 'alpha charlie delta totally different second message here now';
    expect(collapseDoubleBroadcast(text)).toBe(text);
  });

  it('splits on the "I say again" delimiter only when opted in', () => {
    const text = 'skyking skyking alpha I say again skyking skyking alpha';
    // Default (similarity) path: phrase is not a delimiter.
    expect(collapseDoubleBroadcast(text)).not.toBe('skyking skyking alpha');
    // Opt-in: delimiter wins, returns the head.
    expect(collapseDoubleBroadcast(text, { delimiter: true })).toBe('skyking skyking alpha');
  });
});

describe('normalize — normalizeParsed orchestrator', () => {
  it('ALLSTATIONS: collapses + decodes the body; does NOT invent sender/receiver (#552)', () => {
    const once =
      'all stations all stations FOR ICEMAN FOR ICEMAN alpha charlie delta This is Mainsail out';
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: `${once} ${once}`,
    });
    expect(out.body).toBe('ACD');
    // No captured fields → sender/receiver stay unset (AI owns extraction).
    expect(out.sender).toBeUndefined();
    expect(out.receiver).toBeUndefined();
  });

  it('SKYKING: splits on "I say again", keeps TIME/AUTH inline', () => {
    // Canonical SKYKING (owner): preamble + [CODEWORD] TIME XX AUTH YY,
    // delimited by "I say again", then repeated. TIME/AUTH stay inline.
    const once = 'skyking skyking do not answer alpha time 14 auth 9d';
    const out = normalizeParsed({ type: 'SKYKING', transcript: `${once} I say again ${once}` });
    expect(out.body).toBe(once);
    // Single copy, not doubled; TIME/AUTH preserved inline.
    expect((out.body?.match(/skyking skyking/g) ?? []).length).toBe(1);
    expect(out.body).toContain('time 14');
    expect(out.body).toContain('auth 9d');
  });

  it('SKYKING: does NOT extract sender/receiver from the transcript (#552)', () => {
    // Field extraction is the AI's job now — normalizeParsed must not
    // mine "FOR X FOR X" / "this is X out" out of the raw transcript.
    const once =
      'skyking skyking do not answer FOR ICEMAN FOR ICEMAN alpha time 14 auth 9d this is mainsail out';
    const out = normalizeParsed({ type: 'SKYKING', transcript: `${once} I say again ${once}` });
    expect(out.receiver).toBeUndefined();
    expect(out.sender).toBeUndefined();
  });

  it('passes captured body/sender/receiver through (AI-supplied fields)', () => {
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: 'all stations alpha charlie delta This is Mainsail out',
      sender: 'Offutt',
      receiver: 'Raptor',
      body: 'Alpha Charlie Delta',
    });
    // Captured sender/receiver pass through; captured phonetic body decodes.
    expect(out.sender).toBe('Offutt');
    expect(out.receiver).toBe('Raptor');
    expect(out.body).toBe('ACD');
  });

  it('ALLSTATIONS: trusts an already-decoded body instead of re-decoding to empty (#559)', () => {
    // The AI returns the body already decoded (per the fallback prompt).
    // decodePhonetic on alphanumeric letters yields "" — the body must NOT
    // collapse to "" (which upstream turns into the raw transcript); it
    // passes through unchanged.
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: 'all stations all stations papa bravo mike delta uniform this is dutchbox out',
      body: 'PBMDU',
    });
    expect(out.body).toBe('PBMDU');
  });

  it('ALLSTATIONS: still decodes a raw phonetic captured body (#559)', () => {
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: 'all stations all stations alpha charlie delta',
      body: 'Alpha Charlie Delta',
    });
    expect(out.body).toBe('ACD');
  });

  it('ALLSTATIONS: is NOT truncated by an "I say again" phrase in its content', () => {
    // Delimiter split is SKYKING-only — ALLSTATIONS must decode every
    // phonetic letter, before and after the phrase.
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: 'all stations alpha charlie i say again delta echo',
    });
    expect(out.body).toBe('ACDE');
  });

  it('OTHER: passthrough — no decode, no collapse forced, body is the trimmed transcript', () => {
    const out = normalizeParsed({ type: 'OTHER', transcript: '  some freeform note  ' });
    expect(out.body).toBe('some freeform note');
  });
});
