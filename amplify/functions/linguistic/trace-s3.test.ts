import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = sendMock;
  },
  PutObjectCommand: class {
    __input: unknown;
    constructor(input: unknown) {
      this.__input = input;
    }
  },
}));

import { makeDiagnosticsPutObject } from './trace-s3';

describe('makeDiagnosticsPutObject (#749)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('returns undefined when no bucket is configured (size guard then drops)', () => {
    expect(makeDiagnosticsPutObject(undefined)).toBeUndefined();
    expect(makeDiagnosticsPutObject('')).toBeUndefined();
  });

  it('puts the object with a json content-type for .json keys', async () => {
    const put = makeDiagnosticsPutObject('media-bucket');
    expect(put).toBeDefined();
    await put?.('diagnostics/rec-1/run-response.json', '{"a":1}');
    const input = (sendMock.mock.calls[0]?.[0] as { __input: Record<string, unknown> }).__input;
    expect(input).toMatchObject({
      Bucket: 'media-bucket',
      Key: 'diagnostics/rec-1/run-response.json',
      Body: '{"a":1}',
      ContentType: 'application/json',
    });
  });

  it('uses a text content-type for non-json keys', async () => {
    const put = makeDiagnosticsPutObject('media-bucket');
    await put?.('diagnostics/rec-1/run-prompt.txt', 'PROMPT');
    const input = (sendMock.mock.calls[0]?.[0] as { __input: Record<string, unknown> }).__input;
    expect(input.ContentType).toBe('text/plain; charset=utf-8');
  });
});
