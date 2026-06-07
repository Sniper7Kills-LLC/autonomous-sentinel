import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { FederatedUserStore, FederatedIdentityInput } from './ensure';

/**
 * Raw-DynamoDB adapter for the federated user-row ensure (#783).
 *
 * Raw SDK only (no Amplify Data client) so the worker stays out of the
 * data→function dependency edge. Table names arrive via env (wired in
 * backend.ts): `USER_TABLE_NAME` + `REPUTATION_TABLE_NAME`.
 *
 * Creates are conditional (`attribute_not_exists`) so a concurrent sign-in
 * race can't duplicate a row. Amplify auto-adds non-nullable `createdAt` /
 * `updatedAt`; a raw write must set them itself or later AppSync reads fail on
 * the non-nullable AWSDateTime (#649).
 */

let cached: DynamoDBClient | undefined;
function client(): DynamoDBClient {
  if (!cached) cached = new DynamoDBClient({});
  return cached;
}

function userTable(): string {
  const t = process.env.USER_TABLE_NAME;
  if (!t) throw new Error('federatedUserSync: USER_TABLE_NAME env not set');
  return t;
}
function reputationTable(): string {
  const t = process.env.REPUTATION_TABLE_NAME;
  if (!t) throw new Error('federatedUserSync: REPUTATION_TABLE_NAME env not set');
  return t;
}

async function userExists(cognitoSub: string): Promise<boolean> {
  const res = await client().send(
    new GetItemCommand({
      TableName: userTable(),
      Key: marshall({ cognitoSub }),
      ProjectionExpression: 'cognitoSub',
    }),
  );
  return Boolean(res.Item);
}

async function createUser(input: FederatedIdentityInput): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await client().send(
      new PutItemCommand({
        TableName: userTable(),
        Item: marshall(
          {
            cognitoSub: input.cognitoSub,
            email: input.email ?? null,
            displayName: input.displayName ?? null,
            preferredUsername: input.preferredUsername ?? null,
            claimStatus: 'FRESH_SIGNUP',
            piiBlanked: false,
            createdAt: now,
            updatedAt: now,
          },
          { removeUndefinedValues: true },
        ),
        ConditionExpression: 'attribute_not_exists(cognitoSub)',
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

async function ensureReputation(cognitoSub: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await client().send(
      new PutItemCommand({
        TableName: reputationTable(),
        Item: marshall({
          userId: cognitoSub,
          validatedSubmissions: 0,
          acceptedCorrections: 0,
          roleBonus: 0,
          computedWeight: 1,
          createdAt: now,
          updatedAt: now,
        }),
        ConditionExpression: 'attribute_not_exists(userId)',
      }),
    );
  } catch (err) {
    // Row already present (a prior sync) — idempotent no-op.
    if (err instanceof ConditionalCheckFailedException) return;
    throw err;
  }
}

export function createDynamoUserStore(): FederatedUserStore {
  return { userExists, createUser, ensureReputation };
}
