import { describe, it, expect } from 'vitest';

import {
  decodePhonetic,
  collapseDoubleBroadcast,
  extractSender,
  extractReceiver,
  countCharacters,
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

describe('normalize — countCharacters', () => {
  it('counts alphanumeric characters in the decoded body', () => {
    expect(countCharacters('ACD')).toBe(3);
  });

  it('ignores whitespace', () => {
    expect(countCharacters('A C D')).toBe(3);
  });

  it('is zero for empty body', () => {
    expect(countCharacters('')).toBe(0);
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
    expect(out.characterCount).toBe(3);
    expect(out.sender).toBe('Mainsail');
    expect(out.receiver).toBe('ICEMAN');
  });

  it('SKYKING: collapses the double broadcast but does NOT phonetic-decode the body', () => {
    // SKYKING body format is owed by owner — collapse + extract only,
    // body left as the collapsed transcript (no NATO decode).
    const once = 'skyking skyking do not answer FOR ICEMAN FOR ICEMAN time 14 authentication 9D';
    const out = normalizeParsed({ type: 'SKYKING', transcript: `${once} ${once}` });
    expect(out.receiver).toBe('ICEMAN');
    // Not decoded to alphanumeric — preserves the collapsed text.
    expect(out.body).toContain('time 14');
    // Single copy, not doubled.
    expect((out.body?.match(/skyking skyking/g) ?? []).length).toBe(1);
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

  it('OTHER: passthrough — no decode, no collapse forced, body is the trimmed transcript', () => {
    const out = normalizeParsed({ type: 'OTHER', transcript: '  some freeform note  ' });
    expect(out.body).toBe('some freeform note');
  });
});
