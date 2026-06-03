import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handler,
  __setDeps,
  __resetDeps,
  MAX_VERSION_ALLOC_ATTEMPTS,
  type PromptTemplateRow,
  type PromptTemplateStore,
} from './handler';

const ADMIN = { sub: 'admin-sub', groups: ['admin'] };
const MEMBER = { sub: 'member-sub', groups: ['member'] };

function event(fieldName: string, args: Record<string, unknown>, identity: unknown) {
  return { fieldName, arguments: args, identity, request: { headers: {} } } as never;
}

function call(fieldName: string, args: Record<string, unknown>, identity: unknown) {
  // Lambda handlers receive (event, context, callback); pass all three so
  // the explicit-arity signature is exercised.
  return (
    handler as unknown as (e: unknown, c: unknown, cb: unknown) => Promise<PromptTemplateRow | null>
  )(event(fieldName, args, identity), {}, () => undefined);
}

const FIXED_NOW = new Date('2026-06-03T12:00:00.000Z');
const NOW_ISO = FIXED_NOW.toISOString();

type StoreMocks = {
  getById: ReturnType<typeof vi.fn<PromptTemplateStore['getById']>>;
  listByPromptId: ReturnType<typeof vi.fn<PromptTemplateStore['listByPromptId']>>;
  putNewVersion: ReturnType<typeof vi.fn<PromptTemplateStore['putNewVersion']>>;
  activate: ReturnType<typeof vi.fn<PromptTemplateStore['activate']>>;
};

function makeStore(): StoreMocks & { store: PromptTemplateStore } {
  const getById = vi.fn<PromptTemplateStore['getById']>(() => Promise.resolve(null));
  const listByPromptId = vi.fn<PromptTemplateStore['listByPromptId']>(() => Promise.resolve([]));
  const putNewVersion = vi.fn<PromptTemplateStore['putNewVersion']>(() => Promise.resolve());
  const activate = vi.fn<PromptTemplateStore['activate']>(() => Promise.resolve());
  return {
    getById,
    listByPromptId,
    putNewVersion,
    activate,
    store: { getById, listByPromptId, putNewVersion, activate },
  };
}

const CONFLICT = Object.assign(new Error('taken'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => __resetDeps());

describe('activatePromptTemplate', () => {
  it('flips the target active and every prior-active sibling inactive in one transaction', async () => {
    const m = makeStore();
    m.getById.mockImplementation((id) =>
      Promise.resolve(id === 't2' ? { id: 't2', promptId: 'p', version: 2, isActive: true } : null),
    );
    m.listByPromptId.mockResolvedValue([
      { id: 't1', promptId: 'p', version: 1, isActive: true },
      { id: 't2', promptId: 'p', version: 2, isActive: false },
      { id: 't3', promptId: 'p', version: 3, isActive: true },
    ]);
    __setDeps({ store: m.store, now: () => FIXED_NOW });

    const out = await call('activatePromptTemplate', { id: 't2' }, ADMIN);

    expect(m.activate).toHaveBeenCalledWith('t2', ['t1', 't3'], NOW_ISO);
    expect(out?.isActive).toBe(true);
  });

  it('passes an empty prior-active list when nothing else is active', async () => {
    const m = makeStore();
    m.getById.mockResolvedValue({ id: 't1', promptId: 'p', version: 1, isActive: true });
    m.listByPromptId.mockResolvedValue([{ id: 't1', promptId: 'p', version: 1, isActive: false }]);
    __setDeps({ store: m.store, now: () => FIXED_NOW });

    await call('activatePromptTemplate', { id: 't1' }, ADMIN);
    expect(m.activate).toHaveBeenCalledWith('t1', [], NOW_ISO);
  });

  it('rejects a non-admin caller', async () => {
    __setDeps({ store: makeStore().store, now: () => FIXED_NOW });
    await expect(call('activatePromptTemplate', { id: 't1' }, MEMBER)).rejects.toThrow(
      /not in the admin group/,
    );
  });

  it('rejects a missing id', async () => {
    __setDeps({ store: makeStore().store, now: () => FIXED_NOW });
    await expect(call('activatePromptTemplate', {}, ADMIN)).rejects.toThrow(
      /id argument is required/,
    );
  });

  it('throws when the target row does not exist', async () => {
    __setDeps({ store: makeStore().store, now: () => FIXED_NOW });
    await expect(call('activatePromptTemplate', { id: 'gone' }, ADMIN)).rejects.toThrow(
      /not found/,
    );
  });
});

describe('savePromptTemplateVersion', () => {
  it('allocates max(version)+1 with a synthesised composite id and inactive flag', async () => {
    const m = makeStore();
    m.listByPromptId.mockResolvedValue([
      { id: 'p#v2', promptId: 'p', version: 2 },
      { id: 'p#v5', promptId: 'p', version: 5 },
    ]);
    __setDeps({ store: m.store, now: () => FIXED_NOW });

    const out = await call(
      'savePromptTemplateVersion',
      { promptId: 'p', body: 'hello {{TRANSCRIPT}}', notes: 'why' },
      ADMIN,
    );

    expect(out?.version).toBe(6);
    expect(out?.id).toBe('p#v6');
    expect(out?.isActive).toBe(false);
    expect(out?.createdBy).toBe('admin-sub');
    const put = m.putNewVersion.mock.calls[0]![0];
    expect(put.id).toBe('p#v6');
    expect(put.version).toBe(6);
  });

  it('starts at version 1 when no versions exist', async () => {
    const m = makeStore();
    __setDeps({ store: m.store, now: () => FIXED_NOW });
    const out = await call(
      'savePromptTemplateVersion',
      { promptId: 'p', body: '{{TRANSCRIPT}}' },
      ADMIN,
    );
    expect(out?.version).toBe(1);
    expect(out?.id).toBe('p#v1');
  });

  it('rejects a body missing the placeholder before any write', async () => {
    const m = makeStore();
    __setDeps({ store: m.store, now: () => FIXED_NOW });
    await expect(
      call('savePromptTemplateVersion', { promptId: 'p', body: 'no placeholder' }, ADMIN),
    ).rejects.toThrow(/\{\{TRANSCRIPT\}\}/);
    expect(m.putNewVersion).not.toHaveBeenCalled();
  });

  it('retries with the new max when a concurrent save wins the version race', async () => {
    const m = makeStore();
    let attempt = 0;
    m.listByPromptId.mockImplementation(() =>
      Promise.resolve([
        { id: 'p#v1', promptId: 'p', version: 1 },
        { id: 'p#v2', promptId: 'p', version: 2 },
        // After the loser retries, the scan observes the winner's v3.
        ...(attempt > 0 ? [{ id: 'p#v3', promptId: 'p', version: 3 }] : []),
      ]),
    );
    m.putNewVersion.mockImplementation(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(CONFLICT) : Promise.resolve();
    });
    __setDeps({ store: m.store, now: () => FIXED_NOW });

    const out = await call(
      'savePromptTemplateVersion',
      { promptId: 'p', body: '{{TRANSCRIPT}}' },
      ADMIN,
    );
    expect(out?.version).toBe(4);
    expect(m.putNewVersion.mock.calls.length).toBe(2);
  });

  it('gives up after the bounded retry budget under sustained contention', async () => {
    const m = makeStore();
    m.listByPromptId.mockResolvedValue([{ id: 'p#v1', promptId: 'p', version: 1 }]);
    m.putNewVersion.mockImplementation(() => Promise.reject(CONFLICT));
    __setDeps({ store: m.store, now: () => FIXED_NOW });

    await expect(
      call('savePromptTemplateVersion', { promptId: 'p', body: '{{TRANSCRIPT}}' }, ADMIN),
    ).rejects.toThrow(/could not allocate a version/);
    expect(m.putNewVersion.mock.calls.length).toBe(MAX_VERSION_ALLOC_ATTEMPTS);
  });

  it('rethrows a non-conditional error without retrying', async () => {
    const m = makeStore();
    m.putNewVersion.mockImplementation(() => Promise.reject(new Error('boom')));
    __setDeps({ store: m.store, now: () => FIXED_NOW });
    await expect(
      call('savePromptTemplateVersion', { promptId: 'p', body: '{{TRANSCRIPT}}' }, ADMIN),
    ).rejects.toThrow(/boom/);
    expect(m.putNewVersion.mock.calls.length).toBe(1);
  });

  it('rejects a non-admin caller', async () => {
    __setDeps({ store: makeStore().store, now: () => FIXED_NOW });
    await expect(
      call('savePromptTemplateVersion', { promptId: 'p', body: '{{TRANSCRIPT}}' }, MEMBER),
    ).rejects.toThrow(/not in the admin group/);
  });
});

describe('handler dispatch', () => {
  it('throws on an unsupported fieldName', async () => {
    __setDeps({ store: makeStore().store, now: () => FIXED_NOW });
    await expect(call('nope', {}, ADMIN)).rejects.toThrow(/unsupported fieldName/);
  });
});
