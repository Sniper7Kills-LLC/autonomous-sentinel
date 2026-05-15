import { describe, it, expect, vi } from 'vitest';
import { handler } from './handler';
import type { S3Event } from 'aws-lambda';

describe('preprocess handler', () => {
  it('processes each S3 record without throwing', async () => {
    const event: S3Event = {
      Records: [
        {
          eventVersion: '2.1',
          eventSource: 'aws:s3',
          awsRegion: 'us-east-1',
          eventTime: '2026-05-15T00:00:00Z',
          eventName: 'ObjectCreated:Put',
          userIdentity: { principalId: 'EXAMPLE' },
          requestParameters: { sourceIPAddress: '127.0.0.1' },
          responseElements: {
            'x-amz-request-id': 'EXAMPLE',
            'x-amz-id-2': 'EXAMPLE',
          },
          s3: {
            s3SchemaVersion: '1.0',
            configurationId: 'test',
            bucket: {
              name: 'test-bucket',
              ownerIdentity: { principalId: 'EXAMPLE' },
              arn: 'arn:aws:s3:::test-bucket',
            },
            object: {
              key: 'recordings/originals/test-recording.wav',
              size: 1024,
              eTag: 'abc',
              sequencer: '0',
            },
          },
        },
      ],
    };

    // Spy on both log + info so this test is independent of the lint-driven
    // console.log → console.info migration (#2).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).resolves.not.toThrow();
    const calls = [...logSpy.mock.calls, ...infoSpy.mock.calls];
    expect(calls).toContainEqual([
      'preprocess: received',
      expect.objectContaining({ bucket: 'test-bucket' }),
    ]);
    logSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
