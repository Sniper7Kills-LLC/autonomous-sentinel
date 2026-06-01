/**
 * WCAG 2.1 relative-luminance + contrast-ratio helpers (#73).
 *
 * Pure, dependency-free implementations of the formulae in the spec so
 * the unit test in `contrast.test.ts` can assert that the design-token
 * colour pairs in `app/globals.css` meet the AA thresholds (4.5:1 for
 * body text, 3:1 for large text / UI components). This is the issue's
 * "npm run contrast" intent, implemented as a unit test rather than a
 * separate script.
 *
 * Refs:
 * - https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * - https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

/** AA contrast minimum for normal-size body text. */
export const AA_BODY = 4.5;
/** AA contrast minimum for large text (≥24px, or ≥18.66px bold) and UI components. */
export const AA_LARGE = 3;

/** Parsed sRGB triple, each channel 0–255. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse a `#rgb` or `#rrggbb` hex colour to an {@link Rgb} triple.
 * Throws on anything that is not a valid 3- or 6-digit hex string —
 * design tokens are authored by hand so a typo should fail loud.
 */
export function parseHex(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, '');
  const expanded =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`invalid hex colour: ${hex}`);
  }
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

/** Linearise a single 0–255 sRGB channel per the WCAG transfer function. */
function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Relative luminance (0–1) of a colour per WCAG 2.1. Accepts a hex
 * string or an already-parsed {@link Rgb}.
 */
export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color;
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/**
 * Contrast ratio (1–21) between two colours per WCAG 2.1. Order of
 * arguments does not matter; the spec normalises lighter-over-darker.
 */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** True when `fg` over `bg` clears the given AA threshold (default body 4.5:1). */
export function meetsAA(fg: string | Rgb, bg: string | Rgb, min: number = AA_BODY): boolean {
  return contrastRatio(fg, bg) >= min;
}
