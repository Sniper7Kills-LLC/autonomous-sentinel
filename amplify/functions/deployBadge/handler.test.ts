import { describe, it, expect, afterEach } from 'vitest';
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import type { JobSummary } from '@aws-sdk/client-amplify';
import { handler, buildShieldsPayload, __setDeps, __resetDeps } from './handler';

const FAKE_EVENT = {} as LambdaFunctionURLEvent;

interface ShieldsBody {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
}

function bodyOf(res: APIGatewayProxyStructuredResultV2): ShieldsBody {
  const raw = res.body ?? '';
  return JSON.parse(raw) as ShieldsBody;
}

function makeJob(status: JobSummary['status'], jobId = '99'): JobSummary {
  return { jobId, status } as JobSummary;
}

afterEach(() => __resetDeps());

describe('deployBadge — payload mapping', () => {
  it('maps SUCCEED → green "live (#N)"', () => {
    const p = buildShieldsPayload(makeJob('SUCCEED', '61'));
    expect(p.message).toBe('live (#61)');
    expect(p.color).toBe('success');
  });

  it('maps RUNNING → blue "deploying (#N)"', () => {
    const p = buildShieldsPayload(makeJob('RUNNING', '62'));
    expect(p.message).toBe('deploying (#62)');
    expect(p.color).toBe('blue');
  });

  it('maps PENDING and PROVISIONING the same as RUNNING', () => {
    expect(buildShieldsPayload(makeJob('PENDING', '63')).color).toBe('blue');
    expect(buildShieldsPayload(makeJob('PROVISIONING', '64')).color).toBe('blue');
  });

  it('maps FAILED → red "failed (#N)"', () => {
    const p = buildShieldsPayload(makeJob('FAILED', '60'));
    expect(p.message).toBe('failed (#60)');
    expect(p.color).toBe('critical');
  });

  it('maps CANCELLED / CANCELLING → grey "cancelled (#N)"', () => {
    expect(buildShieldsPayload(makeJob('CANCELLED', '50')).color).toBe('lightgrey');
    expect(buildShieldsPayload(makeJob('CANCELLING', '51')).color).toBe('lightgrey');
  });

  it('renders "no builds" / grey when ListJobs returns empty', () => {
    const p = buildShieldsPayload(null);
    expect(p.message).toBe('no builds');
    expect(p.color).toBe('lightgrey');
  });

  it('falls back to a lowercased unknown status', () => {
    const p = buildShieldsPayload(makeJob('SOMETHING_NEW' as never, '70'));
    expect(p.message).toBe('something_new (#70)');
    expect(p.color).toBe('lightgrey');
  });

  it('pins the shields.io envelope fields', () => {
    const p = buildShieldsPayload(makeJob('SUCCEED'));
    expect(p.schemaVersion).toBe(1);
    expect(p.label).toBe('AWS Amplify deploy');
    expect(p.cacheSeconds).toBe(300);
  });
});

describe('deployBadge — handler response', () => {
  it('returns the SUCCEED payload as JSON with cache headers', async () => {
    __setDeps({
      listLatestJob: () => Promise.resolve(makeJob('SUCCEED', '61')),
    });
    const res = await handler(FAKE_EVENT);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expect(res.headers?.['Cache-Control']).toBe('public, max-age=300');
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(bodyOf(res).message).toBe('live (#61)');
  });

  it('emits a grey "unknown" badge when ListJobs throws — never 5xx-s', async () => {
    __setDeps({
      listLatestJob: () => Promise.reject(new Error('throttled')),
    });
    const res = await handler(FAKE_EVENT);
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body.message).toBe('unknown');
    expect(body.color).toBe('lightgrey');
  });
});
