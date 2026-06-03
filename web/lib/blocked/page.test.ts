import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeIso2, fetchBlockedContent, DEFAULT_BLOCKED_CONTENT } from './page';

const getMock = vi.fn();

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    models: {
      BannedRegionPage: {
        get: getMock,
      },
    },
  }),
}));

vi.mock('@/lib/auth/mode', () => ({
  resolveAuthMode: vi.fn().mockResolvedValue('identityPool'),
}));

describe('normalizeIso2', () => {
  it('returns the upper-cased code for a valid two-letter input', () => {
    expect(normalizeIso2('US')).toBe('US');
  });

  it('trims and upper-cases', () => {
    expect(normalizeIso2('  us  ')).toBe('US');
  });

  it('rejects non-two-letter input', () => {
    expect(normalizeIso2('USA')).toBeNull();
    expect(normalizeIso2('U')).toBeNull();
    expect(normalizeIso2('U1')).toBeNull();
    expect(normalizeIso2('12')).toBeNull();
  });

  it('returns null for empty / nullish input', () => {
    expect(normalizeIso2('')).toBeNull();
    expect(normalizeIso2(null)).toBeNull();
    expect(normalizeIso2(undefined)).toBeNull();
  });
});

describe('fetchBlockedContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the default content for a null iso2 without querying', async () => {
    const content = await fetchBlockedContent(null);
    expect(content).toEqual(DEFAULT_BLOCKED_CONTENT);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns the default content for an invalid iso2 without querying', async () => {
    const content = await fetchBlockedContent('usa');
    expect(content).toEqual(DEFAULT_BLOCKED_CONTENT);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns custom content when the model returns an enabled row', async () => {
    getMock.mockResolvedValue({
      data: {
        countryCode: 'US',
        title: 'No access from the United States',
        bodyMarkdown: 'You are **blocked**.',
        enabled: true,
      },
      errors: null,
    });
    const content = await fetchBlockedContent('us');
    expect(content).toEqual({
      countryCode: 'US',
      title: 'No access from the United States',
      bodyMarkdown: 'You are **blocked**.',
      isCustom: true,
    });
    expect(getMock).toHaveBeenCalledWith({ countryCode: 'US' }, { authMode: 'identityPool' });
  });

  it('falls back to default when the row is missing', async () => {
    getMock.mockResolvedValue({ data: null, errors: null });
    const content = await fetchBlockedContent('US');
    expect(content).toEqual(DEFAULT_BLOCKED_CONTENT);
  });

  it('falls back to default when the row is disabled', async () => {
    getMock.mockResolvedValue({
      data: {
        countryCode: 'US',
        title: 'Hidden',
        bodyMarkdown: 'Hidden',
        enabled: false,
      },
      errors: null,
    });
    const content = await fetchBlockedContent('US');
    expect(content).toEqual(DEFAULT_BLOCKED_CONTENT);
  });

  it('falls back to default on AppSync errors', async () => {
    getMock.mockResolvedValue({
      data: null,
      errors: [{ message: 'boom' }],
    });
    const content = await fetchBlockedContent('US');
    expect(content).toEqual(DEFAULT_BLOCKED_CONTENT);
  });

  it('falls back to default when the get call throws', async () => {
    getMock.mockRejectedValue(new Error('network down'));
    const content = await fetchBlockedContent('US');
    expect(content).toEqual(DEFAULT_BLOCKED_CONTENT);
  });
});
