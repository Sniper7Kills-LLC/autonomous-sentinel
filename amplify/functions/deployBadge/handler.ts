import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { AmplifyClient, ListJobsCommand, type JobSummary } from '@aws-sdk/client-amplify';

/**
 * Lambda Function URL handler that renders shields.io endpoint JSON
 * describing the most recent Amplify Hosting deploy for `main`.
 *
 * Output shape — https://shields.io/endpoint
 *
 *   {
 *     "schemaVersion": 1,
 *     "label": "AWS Amplify deploy",
 *     "message": "live (#61)",
 *     "color": "success",
 *     "cacheSeconds": 300,
 *     "namedLogo": "awsamplify",
 *     "logoColor": "white"
 *   }
 *
 * Status mapping (`JobSummary.status`):
 *
 *   - SUCCEED                                    → green / "live (#N)"
 *   - PENDING / PROVISIONING / RUNNING           → blue  / "deploying (#N)"
 *   - FAILED                                     → red   / "failed (#N)"
 *   - CANCELLING / CANCELLED                     → grey  / "cancelled (#N)"
 *   - (no jobs)                                  → grey  / "no builds"
 *
 * Errors fall back to a grey "unknown" badge instead of throwing so a
 * cross-region outage doesn't take the README image down — shields.io
 * already returns its own error indicator if the endpoint itself
 * 5xx-s, which is a worse UX.
 */

interface ShieldsEndpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
  namedLogo: string;
  logoColor: string;
}

const LABEL = 'AWS Amplify deploy';
const CACHE_SECONDS = 300;

export interface DeployBadgeDeps {
  listLatestJob: () => Promise<JobSummary | null>;
}

let injected: Partial<DeployBadgeDeps> = {};

export function __setDeps(deps: Partial<DeployBadgeDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedClient: AmplifyClient | null = null;
function client(): AmplifyClient {
  if (!cachedClient) {
    cachedClient = new AmplifyClient({});
  }
  return cachedClient;
}

function appId(): string {
  const v = process.env.AMPLIFY_APP_ID;
  if (!v) throw new Error('deployBadge: AMPLIFY_APP_ID env var is required');
  return v;
}

function branchName(): string {
  return process.env.AMPLIFY_BRANCH ?? 'main';
}

async function defaultListLatestJob(): Promise<JobSummary | null> {
  const res = await client().send(
    new ListJobsCommand({
      appId: appId(),
      branchName: branchName(),
      maxResults: 1,
    }),
  );
  return res.jobSummaries?.[0] ?? null;
}

function resolveDeps(): DeployBadgeDeps {
  return { listLatestJob: injected.listLatestJob ?? defaultListLatestJob };
}

export function buildShieldsPayload(job: JobSummary | null): ShieldsEndpoint {
  const base: Pick<
    ShieldsEndpoint,
    'schemaVersion' | 'label' | 'cacheSeconds' | 'namedLogo' | 'logoColor'
  > = {
    schemaVersion: 1,
    label: LABEL,
    cacheSeconds: CACHE_SECONDS,
    namedLogo: 'awsamplify',
    logoColor: 'white',
  };

  if (!job) {
    return { ...base, message: 'no builds', color: 'lightgrey' };
  }
  const n = job.jobId ?? '?';
  switch (job.status) {
    case 'SUCCEED':
      return { ...base, message: `live (#${n})`, color: 'success' };
    case 'PENDING':
    case 'PROVISIONING':
    case 'RUNNING':
      return { ...base, message: `deploying (#${n})`, color: 'blue' };
    case 'FAILED':
      return { ...base, message: `failed (#${n})`, color: 'critical' };
    case 'CANCELLING':
    case 'CANCELLED':
      return { ...base, message: `cancelled (#${n})`, color: 'lightgrey' };
    default:
      return {
        ...base,
        message: `${(job.status ?? 'unknown').toLowerCase()} (#${n})`,
        color: 'lightgrey',
      };
  }
}

export const handler = async (
  _event: LambdaFunctionURLEvent,
): Promise<APIGatewayProxyStructuredResultV2> => {
  let payload: ShieldsEndpoint;
  try {
    const job = await resolveDeps().listLatestJob();
    payload = buildShieldsPayload(job);
  } catch (err) {
    console.error('deployBadge: ListJobs failed — emitting unknown badge', err);
    payload = {
      schemaVersion: 1,
      label: LABEL,
      message: 'unknown',
      color: 'lightgrey',
      cacheSeconds: CACHE_SECONDS,
      namedLogo: 'awsamplify',
      logoColor: 'white',
    };
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(payload),
  };
};
