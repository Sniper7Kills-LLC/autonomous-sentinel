import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  ScanCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * Lambda-backed AppSync resolver for the atomic LinguisticPromptTemplate
 * admin mutations (#572). Replaces the non-atomic, client-side
 * two-phase activation + `max(version)+1` create the admin UI used
 * before this landed (see `web/lib/admin/linguistic.ts`).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `activatePromptTemplate(id)` — flips exactly one version active +
 *     every other inactive in a single TransactWriteItems.
 *   - `savePromptTemplateVersion(promptId, body, notes)` — conditional
 *     create allocating the next version atomically.
 *
 * Authz is enforced both at the schema layer (`allow.group('admin')`)
 * and re-checked here (the handler rejects a non-admin identity) so a
 * directly-invoked Lambda can't bypass the group gate.
 */

export type PromptTemplateRow = {
  id: string;
  promptId?: string | null;
  version?: number | null;
  body?: string | null;
  isActive?: boolean | null;
  notes?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [k: string]: unknown;
};

/** The `{{TRANSCRIPT}}` placeholder the Lambda render step requires (#63). */
export const TRANSCRIPT_PLACEHOLDER = '{{TRANSCRIPT}}';

/** Bounded retry budget for the version-allocation conditional create. */
export const MAX_VERSION_ALLOC_ATTEMPTS = 5;

/**
 * Storage port — the four DynamoDB operations the dispatchers need.
 * Injected in tests so the handler logic is exercised without AWS.
 */
export interface PromptTemplateStore {
  /** GetItem by primary key (`id`). */
  getById(id: string): Promise<PromptTemplateRow | null>;
  /** Scan + filter every row sharing a `promptId`. */
  listByPromptId(promptId: string): Promise<PromptTemplateRow[]>;
  /**
   * Conditional create under `attribute_not_exists(id)`. Throws an
   * error whose `name` is `ConditionalCheckFailedException` when the
   * synthesised id is already taken (a concurrent save won the race).
   */
  putNewVersion(item: PromptTemplateRow): Promise<void>;
  /**
   * Atomic flip: set `targetId` active + every id in `priorActiveIds`
   * inactive, in a single TransactWriteItems. Stamps `updatedAt = now`.
   */
  activate(targetId: string, priorActiveIds: string[], now: string): Promise<void>;
}

interface Deps {
  store?: PromptTemplateStore;
  now?: () => Date;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

const TABLE_ENV = 'LINGUISTIC_PROMPT_TEMPLATE_TABLE_NAME';

function requireTableName(): string {
  const v = process.env[TABLE_ENV];
  if (!v) {
    throw new Error(`promptTemplateMutations: ${TABLE_ENV} env var is required`);
  }
  return v;
}

function isConditionalCheckFailed(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : undefined;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

const defaultStore: PromptTemplateStore = {
  async getById(id) {
    const res = await getDdbClient().send(
      new GetItemCommand({ TableName: requireTableName(), Key: marshall({ id }) }),
    );
    return res.Item ? (unmarshall(res.Item) as PromptTemplateRow) : null;
  },

  async listByPromptId(promptId) {
    const rows: PromptTemplateRow[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const res = await getDdbClient().send(
        new ScanCommand({
          TableName: requireTableName(),
          FilterExpression: 'promptId = :p',
          ExpressionAttributeValues: marshall({ ':p': promptId }),
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of res.Items ?? []) {
        rows.push(unmarshall(item) as PromptTemplateRow);
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return rows;
  },

  async putNewVersion(item) {
    await getDdbClient().send(
      new PutItemCommand({
        TableName: requireTableName(),
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
  },

  async activate(targetId, priorActiveIds, now) {
    const tableName = requireTableName();
    const transactItems = [
      {
        Update: {
          TableName: tableName,
          Key: marshall({ id: targetId }),
          UpdateExpression: 'SET isActive = :t, updatedAt = :u',
          ExpressionAttributeValues: marshall({ ':t': true, ':u': now }),
          // Guard against activating a row that was deleted between the
          // read and the transaction.
          ConditionExpression: 'attribute_exists(id)',
        },
      },
      ...priorActiveIds.map((pid) => ({
        Update: {
          TableName: tableName,
          Key: marshall({ id: pid }),
          UpdateExpression: 'SET isActive = :f, updatedAt = :u',
          ExpressionAttributeValues: marshall({ ':f': false, ':u': now }),
        },
      })),
    ];
    await getDdbClient().send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
  },
};

function hasGroup(identity: unknown, group: string): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  return Array.isArray(groups) && groups.indexOf(group) >= 0;
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

async function dispatchActivate(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, PromptTemplateRow | null>>[0],
  deps: { store: PromptTemplateStore; now: () => Date },
): Promise<PromptTemplateRow | null> {
  if (!hasGroup(event.identity, 'admin')) {
    throw new Error('activatePromptTemplate: caller is not in the admin group');
  }
  const targetId = typeof event.arguments.id === 'string' ? event.arguments.id : '';
  if (!targetId) {
    throw new Error('activatePromptTemplate: id argument is required');
  }

  const target = await deps.store.getById(targetId);
  if (!target) {
    throw new Error(`activatePromptTemplate: template row not found for id=${targetId}`);
  }
  const promptId = typeof target.promptId === 'string' ? target.promptId : '';
  if (!promptId) {
    throw new Error(`activatePromptTemplate: template ${targetId} has no promptId`);
  }

  const siblings = await deps.store.listByPromptId(promptId);
  const priorActiveIds = siblings
    .filter((r) => r.id !== targetId && Boolean(r.isActive))
    .map((r) => r.id);

  const now = deps.now().toISOString();
  await deps.store.activate(targetId, priorActiveIds, now);

  // Re-read so the returned row reflects the committed flip (isActive +
  // updatedAt) rather than the pre-transaction snapshot.
  const after = await deps.store.getById(targetId);
  return after ?? { ...target, isActive: true, updatedAt: now };
}

async function dispatchSave(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, PromptTemplateRow | null>>[0],
  deps: { store: PromptTemplateStore; now: () => Date },
): Promise<PromptTemplateRow | null> {
  if (!hasGroup(event.identity, 'admin')) {
    throw new Error('savePromptTemplateVersion: caller is not in the admin group');
  }
  const promptId = typeof event.arguments.promptId === 'string' ? event.arguments.promptId : '';
  const body = typeof event.arguments.body === 'string' ? event.arguments.body : '';
  const notes = typeof event.arguments.notes === 'string' ? event.arguments.notes : null;
  if (!promptId) {
    throw new Error('savePromptTemplateVersion: promptId argument is required');
  }
  if (!body) {
    throw new Error('savePromptTemplateVersion: body argument is required');
  }
  if (!body.includes(TRANSCRIPT_PLACEHOLDER)) {
    throw new Error(
      `savePromptTemplateVersion: body must contain the ${TRANSCRIPT_PLACEHOLDER} placeholder`,
    );
  }
  const createdBy = identitySub(event.identity);

  // Allocate the next version under a conditional create. A concurrent
  // admin computing the same max loses the attribute_not_exists race and
  // retries with the freshly-observed max. Bounded so a pathological
  // hammering of the endpoint can't loop forever.
  for (let attempt = 0; attempt < MAX_VERSION_ALLOC_ATTEMPTS; attempt += 1) {
    const siblings = await deps.store.listByPromptId(promptId);
    const maxVersion = siblings.reduce(
      (m, r) => (typeof r.version === 'number' && r.version > m ? r.version : m),
      0,
    );
    const nextVersion = maxVersion + 1;
    const ts = deps.now().toISOString();
    const item: PromptTemplateRow = {
      // Synthesised composite key: a second writer computing the same
      // nextVersion collides here and is rejected, never landing a
      // duplicate (promptId, version).
      id: `${promptId}#v${nextVersion}`,
      promptId,
      version: nextVersion,
      body,
      isActive: false,
      notes,
      createdBy,
      createdAt: ts,
      updatedAt: ts,
      __typename: 'LinguisticPromptTemplate',
    };
    try {
      await deps.store.putNewVersion(item);
      return item;
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `savePromptTemplateVersion: could not allocate a version for ${promptId} after ${MAX_VERSION_ALLOC_ATTEMPTS} attempts (concurrent contention)`,
  );
}

// `_context` / `_callback` are declared explicitly so the test fixtures
// that pass all three Lambda-runtime arguments don't trip CodeQL's
// "Superfluous trailing arguments" rule. The body ignores them.
export const handler: AppSyncResolverHandler<
  Record<string, unknown>,
  PromptTemplateRow | null
> = async (event, _context, _callback) => {
  const store = injected.store ?? defaultStore;
  const now = injected.now ?? (() => new Date());
  const deps = { store, now };

  const field = (event as unknown as { fieldName?: string }).fieldName ?? event.info?.fieldName;
  switch (field) {
    case 'activatePromptTemplate':
      return dispatchActivate(event, deps);
    case 'savePromptTemplateVersion':
      return dispatchSave(event, deps);
    default:
      throw new Error(`promptTemplateMutations: unsupported fieldName "${field}"`);
  }
};
