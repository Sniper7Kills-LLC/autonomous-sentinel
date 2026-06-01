import { describe, it, expect } from 'vitest';
import { contrastRatio, relativeLuminance, parseHex, meetsAA, AA_BODY, AA_LARGE } from './contrast';

describe('parseHex', () => {
  it('parses 6-digit hex', () => {
    expect(parseHex('#ea580c')).toEqual({ r: 0xea, g: 0x58, b: 0x0c });
  });
  it('parses 3-digit shorthand', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });
  it('tolerates a missing leading # and surrounding space', () => {
    expect(parseHex('  000000 ')).toEqual({ r: 0, g: 0, b: 0 });
  });
  it('throws on a malformed value', () => {
    expect(() => parseHex('#zzz')).toThrow(/invalid hex/);
  });
});

describe('relativeLuminance / contrastRatio (WCAG anchors)', () => {
  it('gives 0 luminance for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });
  it('gives the canonical 21:1 for black-on-white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });
  it('is order-independent', () => {
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(
      contrastRatio('#abcdef', '#123456'),
      10,
    );
  });
});

/**
 * Design tokens copied verbatim from `app/globals.css`. If a token in
 * globals.css changes, update it here too — this test is the guardrail
 * that keeps the palette AA-compliant (the issue's "npm run contrast").
 */
const DARK = {
  bg: '#0d100b',
  surface: '#161b13',
  surface2: '#1d241a',
  fg: '#dde1cf',
  fgMuted: '#8a9379',
  fgFaint: '#788563',
  accent: '#ea580c',
  accentFg: '#0d100b',
  info: '#94a3b8',
  danger: '#ef4444',
} as const;

const LIGHT = {
  bg: '#e8e2cf',
  surface: '#f3eedd',
  surface2: '#ddd5be',
  fg: '#1a2014',
  fgMuted: '#545c42',
  fgFaint: '#67613f',
  accent: '#b23b0b',
  accentFg: '#f3eedd',
  info: '#475569',
  danger: '#991b1b',
} as const;

/** [name, foreground, background, threshold] tuples covering the key text + UI pairs. */
type Pair = readonly [string, string, string, number];

const darkPairs: Pair[] = [
  ['fg / bg', DARK.fg, DARK.bg, AA_BODY],
  ['fg / surface', DARK.fg, DARK.surface, AA_BODY],
  ['fg / surface-2', DARK.fg, DARK.surface2, AA_BODY],
  ['fg-muted / bg', DARK.fgMuted, DARK.bg, AA_BODY],
  ['fg-muted / surface', DARK.fgMuted, DARK.surface, AA_BODY],
  ['fg-muted / surface-2', DARK.fgMuted, DARK.surface2, AA_BODY],
  ['fg-faint / bg', DARK.fgFaint, DARK.bg, AA_BODY],
  ['accent / bg (UI)', DARK.accent, DARK.bg, AA_LARGE],
  ['accent / surface (UI)', DARK.accent, DARK.surface, AA_LARGE],
  ['accent-fg / accent (button text)', DARK.accentFg, DARK.accent, AA_BODY],
  ['info / bg', DARK.info, DARK.bg, AA_BODY],
  ['danger / bg', DARK.danger, DARK.bg, AA_LARGE],
  ['danger / surface', DARK.danger, DARK.surface, AA_BODY],
];

const lightPairs: Pair[] = [
  ['fg / bg', LIGHT.fg, LIGHT.bg, AA_BODY],
  ['fg / surface', LIGHT.fg, LIGHT.surface, AA_BODY],
  ['fg / surface-2', LIGHT.fg, LIGHT.surface2, AA_BODY],
  ['fg-muted / bg', LIGHT.fgMuted, LIGHT.bg, AA_BODY],
  ['fg-muted / surface', LIGHT.fgMuted, LIGHT.surface, AA_BODY],
  ['fg-muted / surface-2', LIGHT.fgMuted, LIGHT.surface2, AA_BODY],
  ['fg-faint / bg', LIGHT.fgFaint, LIGHT.bg, AA_BODY],
  ['accent / bg (UI)', LIGHT.accent, LIGHT.bg, AA_LARGE],
  ['accent / surface (UI)', LIGHT.accent, LIGHT.surface, AA_LARGE],
  ['accent-fg / accent (button text)', LIGHT.accentFg, LIGHT.accent, AA_BODY],
  ['info / bg', LIGHT.info, LIGHT.bg, AA_BODY],
  ['danger / bg', LIGHT.danger, LIGHT.bg, AA_LARGE],
  ['danger / surface', LIGHT.danger, LIGHT.surface, AA_BODY],
];

describe('globals.css token pairs meet WCAG 2.1 AA — dark theme', () => {
  it.each(darkPairs)('%s clears %f:1 → %f', (_name, fg, bg, min) => {
    expect(meetsAA(fg, bg, min)).toBe(true);
  });
});

describe('globals.css token pairs meet WCAG 2.1 AA — light theme', () => {
  it.each(lightPairs)('%s clears %f:1 → %f', (_name, fg, bg, min) => {
    expect(meetsAA(fg, bg, min)).toBe(true);
  });
});
