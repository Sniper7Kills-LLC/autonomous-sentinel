import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Loads the shipped CloudFront Function source and extracts `handler` so the
 * exact code that deploys is exercised (CF Functions aren't ES modules, so we
 * eval the source rather than import it).
 */
const source = readFileSync(new URL('./blocked-geo-rewrite.js', import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
const handler = new Function(`${source}; return handler;`)() as (event: CfEvent) => CfRequest;

interface CfHeaderValue {
  value: string;
}
interface CfRequest {
  uri: string;
  querystring: Record<string, CfHeaderValue>;
  headers: Record<string, CfHeaderValue>;
}
interface CfEvent {
  request: CfRequest;
}

function evt(
  uri: string,
  opts: { country?: string; query?: Record<string, CfHeaderValue> } = {},
): CfEvent {
  return {
    request: {
      uri,
      querystring: opts.query ?? {},
      headers: opts.country ? { 'cloudfront-viewer-country': { value: opts.country } } : {},
    },
  };
}

describe('blocked-geo-rewrite CloudFront function (#679)', () => {
  it('adds country to a bare /blocked from the viewer-country header', () => {
    const out = handler(evt('/blocked', { country: 'RU' }));
    expect(out.querystring.country).toEqual({ value: 'RU' });
  });

  it('handles the trailing-slash variant and uppercases the code', () => {
    const out = handler(evt('/blocked/', { country: 'us' }));
    expect(out.querystring.country).toEqual({ value: 'US' });
  });

  it('preserves existing query params while adding country', () => {
    const out = handler(evt('/blocked', { country: 'CN', query: { ref: { value: 'x' } } }));
    expect(out.querystring.ref).toEqual({ value: 'x' });
    expect(out.querystring.country).toEqual({ value: 'CN' });
  });

  it('leaves a /blocked request that already has a country untouched', () => {
    const out = handler(evt('/blocked', { country: 'RU', query: { country: { value: 'KP' } } }));
    expect(out.querystring.country).toEqual({ value: 'KP' });
  });

  it('passes through non-/blocked paths', () => {
    const out = handler(evt('/messages/view', { country: 'RU' }));
    expect(out.querystring.country).toBeUndefined();
  });

  it('passes through when the viewer-country header is absent', () => {
    const out = handler(evt('/blocked'));
    expect(out.querystring.country).toBeUndefined();
  });

  it('ignores a malformed country code', () => {
    expect(handler(evt('/blocked', { country: 'XYZ' })).querystring.country).toBeUndefined();
    expect(handler(evt('/blocked', { country: '1' })).querystring.country).toBeUndefined();
  });
});
