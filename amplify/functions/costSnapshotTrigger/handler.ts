import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsCommandOutput,
} from '@aws-sdk/client-eventbridge';

/**
 * `costSnapshotTrigger` — backs the admin-only `runCostSnapshotNow`
 * mutation (#303).
 *
 * Fires ONE EventBridge custom event to the default bus and returns
 * `{ status: 'queued' }`. The costSnapshotWorker's own stack carries a
 * Rule matching `source: eam.admin` / `detail-type:
 * CostSnapshotManualSync` that runs the worker — so the heavy snapshot
 * work happens fire-and-forget, with NO direct reference from here to
 * the worker (that direct reference is exactly what created the CFN
 * cycle when the worker was the resolver).
 */

export const MANUAL_SYNC_SOURCE = 'eam.admin';
export const MANUAL_SYNC_DETAIL_TYPE = 'CostSnapshotManualSync';

export interface TriggerResult {
  status: 'queued';
}

export interface TriggerDeps {
  putEvents: (detail: { requestedBy: string | null }) => Promise<void>;
}

let injected: Partial<TriggerDeps> = {};

export function __setDeps(deps: Partial<TriggerDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedClient: EventBridgeClient | undefined;
function ebClient(): EventBridgeClient {
  if (!cachedClient) cachedClient = new EventBridgeClient({});
  return cachedClient;
}

async function defaultPutEvents(detail: { requestedBy: string | null }): Promise<void> {
  const res: PutEventsCommandOutput = await ebClient().send(
    new PutEventsCommand({
      Entries: [
        {
          Source: MANUAL_SYNC_SOURCE,
          DetailType: MANUAL_SYNC_DETAIL_TYPE,
          Detail: JSON.stringify(detail),
          // Omit EventBusName → default bus.
        },
      ],
    }),
  );
  if ((res.FailedEntryCount ?? 0) > 0) {
    const entry = res.Entries?.[0];
    throw new Error(
      `costSnapshotTrigger: PutEvents failed (${entry?.ErrorCode ?? 'unknown'}): ${entry?.ErrorMessage ?? ''}`,
    );
  }
}

function resolveDeps(): TriggerDeps {
  return { putEvents: injected.putEvents ?? defaultPutEvents };
}

/**
 * Pull the caller's Cognito `sub` out of the AppSync identity, if
 * present. Best-effort — the event still fires for any admin caller; we
 * only stamp `requestedBy` for the audit trail.
 */
export function extractRequestedBy(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' ? sub : null;
}

export const handler: AppSyncResolverHandler<unknown, TriggerResult> = async (event) => {
  const deps = resolveDeps();
  const requestedBy = extractRequestedBy(event.identity);
  await deps.putEvents({ requestedBy });
  console.info('costSnapshotTrigger: manual sync event queued', { requestedBy });
  return { status: 'queued' };
};
