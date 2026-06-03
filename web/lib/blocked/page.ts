'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Public banned-region landing-page data layer (#202).
 *
 * The admin EDITOR lives in `web/lib/admin/banned-regions.ts`; this is the
 * GUEST-facing read used by the runtime `/blocked` route a WAF-blocked
 * visitor is 403-redirected to. It fetches the per-country
 * `BannedRegionPage` row under the session auth mode (`iam`/identityPool
 * for guests — guest READ is granted on the model).
 *
 * Hard rule: this page MUST NEVER hard-fail for a public visitor. Any
 * error, a missing row, or a disabled (`enabled === false`) row falls back
 * to the generic `DEFAULT_BLOCKED_CONTENT`. We deliberately do NOT throw on
 * AppSync errors here (unlike the admin layer's `throwOnErrors`).
 *
 * Strict HTTP 403 from the route itself is DEFERRED (documented on #202):
 * the WAF custom response already returns 403 + redirects; the App Router
 * server component renders at 200 with `noindex`.
 */

const ISO2_RE = /^[A-Z]{2}$/;

/** Resolved content shown on the public blocked landing page. */
export interface BlockedRegionContent {
  /** ISO-3166-1 alpha-2 code (UPPERCASE) when known, else null. */
  countryCode: string | null;
  title: string;
  bodyMarkdown: string;
  /** true when a custom, enabled per-country row was found. */
  isCustom: boolean;
}

/**
 * Trim + upper-case a raw country code and return it only when it is a
 * valid ISO-3166-1 alpha-2 (two A–Z letters); otherwise null. So `" us "`
 * → `"US"`, `"usa"` → null, `""` / `undefined` → null.
 */
export function normalizeIso2(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return ISO2_RE.test(code) ? code : null;
}

/**
 * Generic fallback shown when there is no enabled custom page for the
 * visitor's region (or the code is unknown / a read error occurs).
 */
export const DEFAULT_BLOCKED_CONTENT: BlockedRegionContent = {
  countryCode: null,
  title: 'Access restricted in your region',
  bodyMarkdown:
    'Access to this service from your region is currently restricted. ' +
    'If you believe this is an error, please contact the operators of this ' +
    'site so we can look into it.',
  isCustom: false,
};

type RawRow = {
  countryCode: string;
  title?: string | null;
  bodyMarkdown?: string | null;
  enabled?: boolean | null;
};

type RawGetResult = {
  data?: RawRow | null;
  errors?: { message: string }[] | null;
};

/**
 * Resolve the landing-page content for a (possibly null/invalid) ISO-2
 * country code. Never throws — always resolves to either a custom enabled
 * row or `DEFAULT_BLOCKED_CONTENT`.
 */
export async function fetchBlockedContent(iso2: string | null): Promise<BlockedRegionContent> {
  const countryCode = normalizeIso2(iso2);
  if (!countryCode) return DEFAULT_BLOCKED_CONTENT;

  try {
    const client = getDataClient();
    // Cast through `unknown` so the type checker does not chase the
    // generated Schema generics (matches the structural-shape pattern in
    // the other lib data layers). Response is validated via `RawGetResult`.
    const getFn = client.models.BannedRegionPage.get as unknown as (
      input: { countryCode: string },
      opts: Record<string, unknown>,
    ) => Promise<RawGetResult>;
    const authMode = await resolveAuthMode();
    const raw = await getFn({ countryCode }, { authMode });

    // Any AppSync error, no row, or a disabled row → generic fallback.
    if (raw.errors?.length) return DEFAULT_BLOCKED_CONTENT;
    const row = raw.data;
    if (!row || row.enabled === false) return DEFAULT_BLOCKED_CONTENT;

    return {
      countryCode,
      title: row.title ?? DEFAULT_BLOCKED_CONTENT.title,
      bodyMarkdown: row.bodyMarkdown ?? DEFAULT_BLOCKED_CONTENT.bodyMarkdown,
      isCustom: true,
    };
  } catch {
    // Public visitors must never see a hard failure here.
    return DEFAULT_BLOCKED_CONTENT;
  }
}
