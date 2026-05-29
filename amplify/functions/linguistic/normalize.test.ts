import { describe, it, expect } from 'vitest';

import {
  decodePhonetic,
  collapseDoubleBroadcast,
  extractSender,
  extractReceiver,
  normalizeParsed,
} from './normalize';

/**
 * Linguistic normalization stage (#495).
 *
 * Pure functions that turn a raw transcript (and the rules-engine /
 * AI-fallback captured fields) into the log-format Message fields:
 * decoded alphanumeric body, de-duplicated double broadcast, and
 * extracted sender / receiver. No DDB, no network — handler wiring
 * lands in #460.
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

describe('normalize — extractSender', () => {
  it('extracts the sender from "This is XXX out."', () => {
    expect(extractSender('All stations ... This is Mainsail out.')).toBe('Mainsail');
  });

  it('is case-insensitive and tolerates trailing punctuation', () => {
    expect(extractSender('this is ANDREWS OUT')).toBe('ANDREWS');
  });

  it('returns undefined when no sender pattern present', () => {
    expect(extractSender('all stations alpha charlie delta')).toBeUndefined();
  });

  it('does not capture the sign-off word in the degenerate "this is out out"', () => {
    expect(extractSender('this is out out')).toBeUndefined();
  });
});

describe('normalize — extractReceiver', () => {
  it('extracts the receiver from "FOR XXXX FOR XXXX" and collapses the repeat', () => {
    expect(extractReceiver('Skyking do not answer FOR ICEMAN FOR ICEMAN time 14')).toBe('ICEMAN');
  });

  it('is case-insensitive', () => {
    expect(extractReceiver('for raptor for raptor')).toBe('raptor');
  });

  it('matches the repeat case-insensitively (JS backref honors /i)', () => {
    // Regression lock: "FOR Raptor FOR raptor" still collapses; the
    // captured value preserves the first occurrence's casing.
    expect(extractReceiver('FOR Raptor FOR raptor')).toBe('Raptor');
  });

  it('returns undefined when the receiver is not stated twice', () => {
    expect(extractReceiver('for iceman time 14 authentication')).toBeUndefined();
  });
});

describe('normalize — normalizeParsed orchestrator', () => {
  it('ALLSTATIONS: collapses, decodes the body, extracts sender/receiver, counts', () => {
    const once =
      'all stations all stations FOR ICEMAN FOR ICEMAN alpha charlie delta This is Mainsail out';
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: `${once} ${once}`,
    });
    expect(out.body).toBe('ACD');
    expect(out.sender).toBe('Mainsail');
    expect(out.receiver).toBe('ICEMAN');
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

  it('SKYKING: extracts sender and receiver when present', () => {
    // A SKYKING CAN carry a receiver ("FOR X FOR X") and a sender
    // ("this is X out") — owner correction. Both are captured.
    const once =
      'skyking skyking do not answer FOR ICEMAN FOR ICEMAN alpha time 14 auth 9d this is mainsail out';
    const out = normalizeParsed({ type: 'SKYKING', transcript: `${once} I say again ${once}` });
    expect(out.receiver).toBe('ICEMAN');
    expect(out.sender).toBe('mainsail');
  });

  it('prefers an already-captured body/sender/receiver over re-extraction', () => {
    const out = normalizeParsed({
      type: 'ALLSTATIONS',
      transcript: 'all stations alpha charlie delta This is Mainsail out',
      sender: 'Offutt',
      receiver: 'Raptor',
      body: 'Alpha Charlie Delta',
    });
    // Captured sender/receiver win; captured phonetic body still decodes.
    expect(out.sender).toBe('Offutt');
    expect(out.receiver).toBe('Raptor');
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
