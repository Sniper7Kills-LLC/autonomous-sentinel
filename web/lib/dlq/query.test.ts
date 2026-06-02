import { describe, it, expect } from 'vitest';
import { toDlqMessageView, PIPELINE_STAGES } from './query';

describe('dlq query — toDlqMessageView (#107)', () => {
  it('narrows a complete raw message', () => {
    const view = toDlqMessageView(
      {
        messageId: 'm1',
        receiptHandle: 'rh1',
        body: '{"recordingId":"rec-1"}',
        recordingId: 'rec-1',
        approximateReceiveCount: 3,
        enqueuedAt: '2026-06-01T00:00:00.000Z',
        errorReason: 'ffmpeg failed',
      },
      'preprocess',
    );
    expect(view).toEqual({
      stage: 'preprocess',
      messageId: 'm1',
      receiptHandle: 'rh1',
      body: '{"recordingId":"rec-1"}',
      recordingId: 'rec-1',
      approximateReceiveCount: 3,
      enqueuedAt: '2026-06-01T00:00:00.000Z',
      errorReason: 'ffmpeg failed',
    });
  });

  it('returns null when messageId or receiptHandle is missing', () => {
    expect(toDlqMessageView({ receiptHandle: 'rh' }, 'transcribe')).toBeNull();
    expect(toDlqMessageView({ messageId: 'm' }, 'transcribe')).toBeNull();
    expect(toDlqMessageView(null, 'transcribe')).toBeNull();
    expect(toDlqMessageView('nope', 'transcribe')).toBeNull();
  });

  it('defaults soft fields when absent or wrong type', () => {
    const view = toDlqMessageView({ messageId: 'm', receiptHandle: 'rh' }, 'linguistic');
    expect(view).toMatchObject({
      body: '',
      recordingId: null,
      approximateReceiveCount: 0,
      enqueuedAt: null,
      errorReason: null,
    });
  });

  it('exposes the three pipeline stages', () => {
    expect(PIPELINE_STAGES).toEqual(['preprocess', 'transcribe', 'linguistic']);
  });
});
