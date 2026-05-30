import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { handler, parseDispatchMessage, __setDeps, __resetDeps } from './handler';
import { BACKEND_ENV_VAR } from './selector';

/**
 * transcribe-dispatch contract (#587):
 *
 *   SQS message `{recordingId, originalKey, contentHash, enqueuedAt,
 *     backendOverride?}` →
 *       resolveBackend(override → config → whisper-local) →
 *       resolveBackendArn(<backend>_FN_ARN) →
 *       Lambda Invoke(InvocationType=Event, Payload=<raw body>)
 *
 *   Routing: no override + no config → whisper-local (the unchanged
 *   happy path). `backendOverride: amazon-transcribe` → transcribe-aws.
 *   Unknown backend → falls back to default. Missing ARN env → throws
 *   (SQS redrives).
 */

const lambdaMock = mockClient(LambdaClient);

const ARNS = {
  WHISPER_LOCAL_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:whisper-local',
  WHISPER_API_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:whisper-api',
  AMAZON_TRANSCRIBE_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:amazon-transcribe',
  BEDROCK_TRANSCRIBE_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:bedrock',
};

function record(body: Record<string, unknown>): SQSRecord {
  return { body: JSON.stringify(body) } as SQSRecord;
}

function event(...bodies: Record<string, unknown>[]): SQSEvent {
  return { Records: bodies.map(record) };
}

beforeEach(() => {
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
});

afterEach(() => {
  __resetDeps();
  vi.restoreAllMocks();
});

function withDeps(overrides: { defaultBackend?: string | null; env?: typeof ARNS } = {}) {
  __setDeps({
    lambda: lambdaMock as unknown as LambdaClient,
    loadConfig: () => Promise.resolve({ defaultBackend: overrides.defaultBackend ?? null }),
    env: overrides.env ?? ARNS,
  });
}

describe('parseDispatchMessage', () => {
  it('parses recordingId + backendOverride from the SQS body', () => {
    const msg = parseDispatchMessage(
      record({ recordingId: 'r1', originalKey: 'k', backendOverride: 'amazon-transcribe' }),
    );
    expect(msg).toEqual({ recordingId: 'r1', backendOverride: 'amazon-transcribe' });
  });

  it('returns null on unparseable JSON', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseDispatchMessage({ body: '{not json' } as SQSRecord)).toBeNull();
  });

  it('returns null when recordingId is missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseDispatchMessage(record({ originalKey: 'k' }))).toBeNull();
  });

  it('leaves backendOverride undefined when absent', () => {
    expect(parseDispatchMessage(record({ recordingId: 'r1', originalKey: 'k' }))).toEqual({
      recordingId: 'r1',
      backendOverride: undefined,
    });
  });
});

describe('handler — routing', () => {
  it('routes to whisper-local (default) when no override + no config — unchanged happy path', async () => {
    withDeps();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handler(event({ recordingId: 'r1', originalKey: 'recordings/originals/r1.wav' }));

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.FunctionName).toBe(ARNS.WHISPER_LOCAL_FN_ARN);
    expect(calls[0]!.args[0].input.InvocationType).toBe('Event');
  });

  it('forwards the original SQS body verbatim as the invoke payload', async () => {
    withDeps();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const body = {
      recordingId: 'r1',
      originalKey: 'recordings/originals/r1.wav',
      contentHash: 'h',
    };
    await handler(event(body));

    const payload = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input.Payload;
    expect(JSON.parse(Buffer.from(payload as Uint8Array).toString())).toEqual(body);
  });

  it('honours backendOverride: amazon-transcribe → routes to transcribe-aws', async () => {
    withDeps();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handler(
      event({ recordingId: 'r1', originalKey: 'k', backendOverride: 'amazon-transcribe' }),
    );

    expect(lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input.FunctionName).toBe(
      ARNS.AMAZON_TRANSCRIBE_FN_ARN,
    );
  });

  it('uses the config defaultBackend when no override', async () => {
    withDeps({ defaultBackend: 'bedrock' });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handler(event({ recordingId: 'r1', originalKey: 'k' }));

    expect(lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input.FunctionName).toBe(
      ARNS.BEDROCK_TRANSCRIBE_FN_ARN,
    );
  });

  it('falls back to the default when the override is an unknown/typo backend', async () => {
    withDeps();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await handler(event({ recordingId: 'r1', originalKey: 'k', backendOverride: 'whisper-locol' }));

    expect(lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input.FunctionName).toBe(
      ARNS.WHISPER_LOCAL_FN_ARN,
    );
  });

  it('throws when the resolved backend ARN env var is unset (SQS redrives)', async () => {
    // env missing WHISPER_LOCAL_FN_ARN → resolveBackendArn throws.
    __setDeps({
      lambda: lambdaMock as unknown as LambdaClient,
      loadConfig: () => Promise.resolve({ defaultBackend: null }),
      env: { ...ARNS, WHISPER_LOCAL_FN_ARN: undefined },
    });
    await expect(handler(event({ recordingId: 'r1', originalKey: 'k' }))).rejects.toThrow(
      /WHISPER_LOCAL_FN_ARN/,
    );
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('skips a malformed record without invoking, processes the rest of the batch', async () => {
    withDeps();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ev = {
      Records: [{ body: '{not json' }, record({ recordingId: 'r2', originalKey: 'k' })],
    } as SQSEvent;
    await handler(ev);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(calls[0]!.args[0].input.Payload as Uint8Array).toString(),
    ) as { recordingId: string };
    expect(payload.recordingId).toBe('r2');
  });
});

describe('env var map sanity', () => {
  it('the test ARN keys line up with BACKEND_ENV_VAR', () => {
    for (const envVar of Object.values(BACKEND_ENV_VAR)) {
      expect(Object.prototype.hasOwnProperty.call(ARNS, envVar)).toBe(true);
    }
  });
});
