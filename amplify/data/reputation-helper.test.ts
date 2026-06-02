import { describe, it, expect, vi } from 'vitest';
import {
  computeWeight,
  roleBonusFor,
  repConstants,
  recomputeReputation,
  type ReputationHelperClient,
} from './reputation-helper';

describe('reputation-helper — computeWeight (#480)', () => {
  const C = repConstants();

  it('matches the CLAUDE.md formula for a plain member', () => {
    // base 1 + 0.1*3 + 0.5*2 = 2.3
    expect(
      computeWeight({ validatedSubmissions: 3, acceptedCorrections: 2, roleBonus: 0 }, C),
    ).toBe(2.3);
  });

  it('caps submission + correction contributions and the net weight', () => {
    expect(
      computeWeight({ validatedSubmissions: 1000, acceptedCorrections: 1000, roleBonus: 2 }, C),
    ).toBe(5);
  });

  it('maps roles to bonuses', () => {
    expect(roleBonusFor('admin')).toBe(2);
    expect(roleBonusFor('moderator')).toBe(1);
    expect(roleBonusFor('member')).toBe(0);
    expect(roleBonusFor(null)).toBe(0);
  });
});

function makeClient(opts: {
  publishedRecordings?: string[];
  acceptedRevisions?: boolean[];
  role?: string;
  updateErrors?: unknown;
}) {
  const update = vi.fn().mockResolvedValue({ data: {}, errors: opts.updateErrors });
  const client: ReputationHelperClient = {
    models: {
      Recording: {
        listRecordingByUploaderId: vi.fn().mockResolvedValue({
          data: (opts.publishedRecordings ?? []).map((s) => ({ transcriptionStatus: s })),
          nextToken: null,
        }),
      },
      TranscriptRevision: {
        listTranscriptRevisionByProposedBy: vi.fn().mockResolvedValue({
          data: (opts.acceptedRevisions ?? []).map((a) => ({ accepted: a })),
          nextToken: null,
        }),
      },
      User: { get: vi.fn().mockResolvedValue({ data: { role: opts.role ?? 'member' } }) },
      Reputation: { update },
    },
  };
  return { client, update };
}

describe('reputation-helper — recomputeReputation (#480)', () => {
  it('counts only PUBLISHED recordings + accepted revisions and writes the weight', async () => {
    const { client, update } = makeClient({
      publishedRecordings: ['PUBLISHED', 'PARSING', 'PUBLISHED', 'FAILED'],
      acceptedRevisions: [true, false, true],
      role: 'member',
    });
    const weight = await recomputeReputation(client, 'u1');
    expect(weight).toBe(2.2); // 1 + 0.1*2 + 0.5*2
    expect(update).toHaveBeenCalledWith({
      userId: 'u1',
      validatedSubmissions: 2,
      acceptedCorrections: 2,
      roleBonus: 0,
      computedWeight: 2.2,
    });
  });

  it('adds the moderator role bonus', async () => {
    const { client, update } = makeClient({ role: 'moderator' });
    await recomputeReputation(client, 'mod-1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ roleBonus: 1, computedWeight: 2 }),
    );
  });

  it('throws when the Reputation update returns errors (caller wraps best-effort)', async () => {
    const { client } = makeClient({ updateErrors: [{ message: 'missing row' }] });
    await expect(recomputeReputation(client, 'u1')).rejects.toThrow(/Reputation.update/);
  });
});
