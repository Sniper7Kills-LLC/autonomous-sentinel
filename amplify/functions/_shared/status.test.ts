import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  setStatus,
  isFailure,
  TERMINAL_STATUSES,
  __setStatusDeps,
  __resetStatusDeps,
  type TranscriptionStatus,
} from './status';

/**
 * Helper-level tests for `setStatus` (#69 shared status helper).
 *
 * Pins the conditional-update shape that prevents PUBLISHED → PARSING
 * regression on duplicate SQS deliveries, the failedReason truncation
 * at 1 KB, and the env / dep-injection contract every consumer Lambda
 * will rely on.
 *
 * No DDB is hit — a stub client captures the `UpdateItemCommand`
 * input and surfaces it for assertion. The actual AWS plumbing is
 * exercised at sandbox-deploy time when consumer Lambdas wire in.
 */

interface CapturedCommand {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

function makeStubClient(): {
  send: (cmd: UpdateItemCommand) => Promise<unknown>;
  calls: CapturedCommand[];
} {
  const calls: CapturedCommand[] = [];
  return {
    send: (cmd: UpdateItemCommand): Promise<unknown> => {
      calls.push(cmd.input as unknown as CapturedCommand);
      return Promise.resolve({});
    },
    calls,
  };
}

beforeEach(() => {
  __resetStatusDeps();
});

describe('setStatus helper — happy path', () => {
  it('writes the new status + ISO timestamp + transcriptionFailed flag on every call', async () => {
    const stub = makeStubClient();
    __setStatusDeps({ client: stub, tableName: 'Recording-Test' });

    await setStatus('rec-1', 'PREPROCESSING', {
      now: () => new Date('2026-05-23T12:00:00.000Z'),
    });

    expect(stub.calls).toHaveLength(1);
    const cmd = stub.calls[0]!;
    expect(cmd.TableName).toBe('Recording-Test');
    expect(cmd.UpdateExpression).toMatch(
      /SET #status = :status, #updatedAt = :now, #failed = :isFailure/,
    );
    expect(cmd.ExpressionAttributeNames['#status']).toBe('transcriptionStatus');
    expect(cmd.ExpressionAttributeNames['#updatedAt']).toBe('transcriptionStatusUpdatedAt');
    expect(cmd.ExpressionAttributeNames['#failed']).toBe('transcriptionFailed');
  });

  it('rejects an empty recordingId — caller bug, fail loud', async () => {
    __setStatusDeps({ client: makeStubClient(), tableName: 'Recording-Test' });
    await expect(setStatus('', 'QUEUED')).rejects.toThrow(/recordingId is required/);
    await expect(setStatus('   ', 'QUEUED')).rejects.toThrow(/recordingId is required/);
  });

  it('rejects when RECORDING_TABLE_NAME is unset — caller bug, fail loud', async () => {
    delete process.env.RECORDING_TABLE_NAME;
    __setStatusDeps({ client: makeStubClient() });
    await expect(setStatus('rec-1', 'QUEUED')).rejects.toThrow(/RECORDING_TABLE_NAME/);
  });
});

describe('setStatus helper — failure transitions', () => {
  it('flips transcriptionFailed=true on PREPROCESS_FAILED / TRANSCRIBE_FAILED / PARSE_FAILED / FAILED', async () => {
    const stub = makeStubClient();
    __setStatusDeps({ client: stub, tableName: 'Recording-Test' });
    const failures: TranscriptionStatus[] = [
      'PREPROCESS_FAILED',
      'TRANSCRIBE_FAILED',
      'PARSE_FAILED',
      'FAILED',
    ];
    for (const s of failures) {
      await setStatus('rec-x', s);
    }
    // Every captured command should set isFailure=true.
    for (const cmd of stub.calls) {
      // Values come marshalled as { ':isFailure': { BOOL: true } } in AttributeValue shape.
      const v = cmd.ExpressionAttributeValues[':isFailure'] as { BOOL: boolean };
      expect(v.BOOL).toBe(true);
    }
  });

  it('stores failedReason when provided, truncated to 1024 chars', async () => {
    const stub = makeStubClient();
    __setStatusDeps({ client: stub, tableName: 'Recording-Test' });
    const longReason = 'x'.repeat(2000);
    await setStatus('rec-x', 'FAILED', { failedReason: longReason });
    const cmd = stub.calls[0]!;
    expect(cmd.ExpressionAttributeNames['#failedReason']).toBe('failedReason');
    const fr = cmd.ExpressionAttributeValues[':failedReason'] as { S: string };
    expect(fr.S.length).toBe(1024);
  });

  it('omits failedReason from the UpdateExpression when not provided (happy-path transitions)', async () => {
    const stub = makeStubClient();
    __setStatusDeps({ client: stub, tableName: 'Recording-Test' });
    await setStatus('rec-x', 'PREPROCESSING');
    const cmd = stub.calls[0]!;
    expect(cmd.UpdateExpression).not.toMatch(/failedReason/);
    expect(cmd.ExpressionAttributeNames['#failedReason']).toBeUndefined();
  });
});

describe('setStatus helper — idempotency + terminal protection', () => {
  it('emits a ConditionExpression that blocks regression from any terminal status', async () => {
    const stub = makeStubClient();
    __setStatusDeps({ client: stub, tableName: 'Recording-Test' });
    await setStatus('rec-x', 'PARSING');
    const cmd = stub.calls[0]!;
    // The condition allows: no-row OR same-status retry OR currentStatus
    // not in the terminal set. The 5 terminal values must all appear
    // as `<> :termN` clauses.
    for (const term of [
      'PUBLISHED',
      'PREPROCESS_FAILED',
      'TRANSCRIBE_FAILED',
      'PARSE_FAILED',
      'FAILED',
    ]) {
      expect(JSON.stringify(cmd.ExpressionAttributeValues)).toContain(term);
    }
    expect(cmd.ConditionExpression).toMatch(/attribute_not_exists/);
    expect(cmd.ConditionExpression).toMatch(/#status = :sameStatus/);
  });

  it('swallows a ConditionalCheckFailedException as a no-op (duplicate SQS delivery on a finished row)', async () => {
    const failing: { send: (cmd: UpdateItemCommand) => Promise<unknown> } = {
      send: () => {
        const err = new Error('Conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        return Promise.reject(err);
      },
    };
    __setStatusDeps({ client: failing, tableName: 'Recording-Test' });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(setStatus('rec-x', 'PARSING')).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it('rethrows non-conditional errors so SQS redrive + DLQ catch real problems', async () => {
    const failing: { send: (cmd: UpdateItemCommand) => Promise<unknown> } = {
      send: () => Promise.reject(new Error('NetworkingError')),
    };
    __setStatusDeps({ client: failing, tableName: 'Recording-Test' });
    await expect(setStatus('rec-x', 'PARSING')).rejects.toThrow(/NetworkingError/);
  });
});

describe('isFailure / TERMINAL_STATUSES', () => {
  it('isFailure marks every *_FAILED + the generic FAILED as failure-flavoured', () => {
    expect(isFailure('PREPROCESS_FAILED')).toBe(true);
    expect(isFailure('TRANSCRIBE_FAILED')).toBe(true);
    expect(isFailure('PARSE_FAILED')).toBe(true);
    expect(isFailure('FAILED')).toBe(true);
    expect(isFailure('PUBLISHED')).toBe(false);
    expect(isFailure('QUEUED')).toBe(false);
    expect(isFailure('PREPROCESSING')).toBe(false);
    expect(isFailure('TRANSCRIBING')).toBe(false);
    expect(isFailure('PARSING')).toBe(false);
  });

  it('TERMINAL_STATUSES covers every non-progress state', () => {
    expect(TERMINAL_STATUSES.has('PUBLISHED')).toBe(true);
    expect(TERMINAL_STATUSES.has('PREPROCESS_FAILED')).toBe(true);
    expect(TERMINAL_STATUSES.has('TRANSCRIBE_FAILED')).toBe(true);
    expect(TERMINAL_STATUSES.has('PARSE_FAILED')).toBe(true);
    expect(TERMINAL_STATUSES.has('FAILED')).toBe(true);
    expect(TERMINAL_STATUSES.has('QUEUED')).toBe(false);
    expect(TERMINAL_STATUSES.has('PREPROCESSING')).toBe(false);
    expect(TERMINAL_STATUSES.has('TRANSCRIBING')).toBe(false);
    expect(TERMINAL_STATUSES.has('PARSING')).toBe(false);
  });
});
