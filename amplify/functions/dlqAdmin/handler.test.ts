import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'aws-lambda';
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { handler, __setDeps, __resetDeps } from './handler';

const context = {} as Context;
const cb = () => undefined;

const ENV = {
  PREPROCESS_QUEUE_URL: 'https://sqs/preprocess',
  PREPROCESS_DLQ_URL: 'https://sqs/preprocess-dlq',
  TRANSCRIBE_QUEUE_URL: 'https://sqs/transcribe',
  TRANSCRIBE_DLQ_URL: 'https://sqs/transcribe-dlq',
  LINGUISTIC_QUEUE_URL: 'https://sqs/linguistic',
  LINGUISTIC_DLQ_URL: 'https://sqs/linguistic-dlq',
};

const adminIdentity = { sub: 'admin-1', groups: ['admin'] };
const memberIdentity = { sub: 'member-1', groups: [] };

/** Builds an AppSync resolver event of the shape the handler reads. */
function event(
  fieldName: string,
  args: Record<string, unknown>,
  identity: unknown = adminIdentity,
) {
  return {
    arguments: args,
    identity,
    info: { fieldName },
    request: { headers: { 'user-agent': 'vitest' } },
  } as never;
}

describe('dlqAdmin handler (#107)', () => {
  beforeEach(() => {
    __resetDeps();
    Object.assign(process.env, ENV);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  describe('authorization', () => {
    it('rejects a non-admin caller on every operation', async () => {
      __setDeps({ sqs: { send: vi.fn() } as never });
      await expect(
        handler(event('listDlqMessages', { stage: 'preprocess' }, memberIdentity), context, cb),
      ).rejects.toThrow(/not in the admin group/);
      await expect(
        handler(
          event(
            'requeueDlqMessage',
            { stage: 'preprocess', receiptHandle: 'r', body: '{}' },
            memberIdentity,
          ),
          context,
          cb,
        ),
      ).rejects.toThrow(/not in the admin group/);
      await expect(
        handler(
          event('dropDlqMessage', { stage: 'preprocess', receiptHandle: 'r' }, memberIdentity),
          context,
          cb,
        ),
      ).rejects.toThrow(/not in the admin group/);
    });

    it('rejects an unknown fieldName', async () => {
      __setDeps({ sqs: { send: vi.fn() } as never });
      await expect(handler(event('bogusOp', {}), context, cb)).rejects.toThrow(
        /unsupported fieldName/,
      );
    });
  });

  describe('listDlqMessages', () => {
    it('rejects an invalid stage', async () => {
      __setDeps({ sqs: { send: vi.fn() } as never });
      await expect(
        handler(event('listDlqMessages', { stage: 'nope' }), context, cb),
      ).rejects.toThrow(/stage must be one of/);
    });

    it('peeks the DLQ, parses metadata, and dedupes by messageId', async () => {
      const send = vi.fn();
      // First round: two messages (one repeats in round 2 → deduped).
      send.mockResolvedValueOnce({
        Messages: [
          {
            MessageId: 'm1',
            ReceiptHandle: 'rh1',
            Body: JSON.stringify({ recordingId: 'rec-1', errorReason: 'ffmpeg blew up' }),
            Attributes: { ApproximateReceiveCount: '3', SentTimestamp: '1700000000000' },
          },
          {
            MessageId: 'm2',
            ReceiptHandle: 'rh2',
            Body: 'not-json',
            Attributes: { ApproximateReceiveCount: '4', SentTimestamp: '1700000005000' },
          },
        ],
      });
      send.mockResolvedValueOnce({
        Messages: [{ MessageId: 'm1', ReceiptHandle: 'rh1b', Body: '{}' }],
      });
      send.mockResolvedValueOnce({ Messages: [] });
      __setDeps({ sqs: { send } as never });

      const res = (await handler(
        event('listDlqMessages', { stage: 'preprocess' }),
        context,
        cb,
      )) as unknown as {
        stage: string;
        messages: Array<Record<string, unknown>>;
      };

      // Peeked the DLQ URL with a zero visibility timeout (no delete).
      const firstCall = send.mock.calls[0]![0] as ReceiveMessageCommand;
      expect(firstCall).toBeInstanceOf(ReceiveMessageCommand);
      expect(firstCall.input.QueueUrl).toBe(ENV.PREPROCESS_DLQ_URL);
      expect(firstCall.input.VisibilityTimeout).toBe(0);

      expect(res.stage).toBe('preprocess');
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0]).toMatchObject({
        messageId: 'm1',
        recordingId: 'rec-1',
        errorReason: 'ffmpeg blew up',
        approximateReceiveCount: 3,
        enqueuedAt: '2023-11-14T22:13:20.000Z',
      });
      // Unparseable body → null metadata, still listed.
      expect(res.messages[1]).toMatchObject({
        messageId: 'm2',
        recordingId: null,
        errorReason: null,
      });
    });
  });

  describe('requeueDlqMessage', () => {
    it('sends the body to the primary queue then deletes from the DLQ + audits', async () => {
      const send = vi.fn().mockResolvedValue({});
      const audit = vi.fn().mockResolvedValue('audit-id');
      __setDeps({ sqs: { send } as never, audit });

      const res = await handler(
        event('requeueDlqMessage', {
          stage: 'transcribe',
          receiptHandle: 'rh-x',
          body: '{"recordingId":"rec-9"}',
          recordingId: 'rec-9',
        }),
        context,
        cb,
      );

      expect(res).toEqual({ status: 'requeued' });
      const sendCmd = send.mock.calls[0]![0] as SendMessageCommand;
      expect(sendCmd).toBeInstanceOf(SendMessageCommand);
      expect(sendCmd.input.QueueUrl).toBe(ENV.TRANSCRIBE_QUEUE_URL);
      expect(sendCmd.input.MessageBody).toBe('{"recordingId":"rec-9"}');
      const delCmd = send.mock.calls[1]![0] as DeleteMessageCommand;
      expect(delCmd).toBeInstanceOf(DeleteMessageCommand);
      expect(delCmd.input.QueueUrl).toBe(ENV.TRANSCRIBE_DLQ_URL);
      expect(delCmd.input.ReceiptHandle).toBe('rh-x');
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ identity: { sub: 'admin-1' } }),
        expect.objectContaining({
          action: 'DLQ_REQUEUE',
          targetType: 'Recording',
          targetId: 'rec-9',
        }),
      );
    });

    it('requires receiptHandle + body', async () => {
      __setDeps({ sqs: { send: vi.fn() } as never, audit: vi.fn() });
      await expect(
        handler(event('requeueDlqMessage', { stage: 'transcribe', body: '{}' }), context, cb),
      ).rejects.toThrow(/receiptHandle argument is required/);
      await expect(
        handler(
          event('requeueDlqMessage', { stage: 'transcribe', receiptHandle: 'r' }),
          context,
          cb,
        ),
      ).rejects.toThrow(/body argument is required/);
    });
  });

  describe('dropDlqMessage', () => {
    it('deletes from the DLQ, marks the Recording FAILED, and audits', async () => {
      const send = vi.fn().mockResolvedValue({});
      const update = vi.fn().mockResolvedValue({ data: { id: 'rec-7' } });
      const audit = vi.fn().mockResolvedValue('audit-id');
      __setDeps({
        sqs: { send } as never,
        dataClient: { models: { Recording: { update } } },
        audit,
        now: () => new Date('2026-06-02T00:00:00.000Z'),
      });

      const res = await handler(
        event('dropDlqMessage', {
          stage: 'linguistic',
          receiptHandle: 'rh-d',
          recordingId: 'rec-7',
        }),
        context,
        cb,
      );

      expect(res).toEqual({ status: 'dropped' });
      const delCmd = send.mock.calls[0]![0] as DeleteMessageCommand;
      expect(delCmd).toBeInstanceOf(DeleteMessageCommand);
      expect(delCmd.input.QueueUrl).toBe(ENV.LINGUISTIC_DLQ_URL);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'rec-7',
          transcriptionStatus: 'FAILED',
          transcriptionFailed: true,
          transcriptionStatusUpdatedAt: '2026-06-02T00:00:00.000Z',
        }),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'DLQ_DROP', targetId: 'rec-7' }),
      );
    });

    it('drops without a Recording update when no recordingId is known', async () => {
      const send = vi.fn().mockResolvedValue({});
      const update = vi.fn();
      const audit = vi.fn().mockResolvedValue('audit-id');
      __setDeps({
        sqs: { send } as never,
        dataClient: { models: { Recording: { update } } },
        audit,
        now: () => new Date('2026-06-02T00:00:00.000Z'),
      });

      const res = await handler(
        event('dropDlqMessage', { stage: 'preprocess', receiptHandle: 'rh-d' }),
        context,
        cb,
      );

      expect(res).toEqual({ status: 'dropped' });
      expect(update).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'DLQ_DROP', targetId: 'dlq:preprocess' }),
      );
    });
  });
});
