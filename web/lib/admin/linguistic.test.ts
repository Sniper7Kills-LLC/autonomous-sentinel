import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mock = ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<unknown>>>;
const listTemplateMock: Mock = vi.fn();
const saveVersionMock: Mock = vi.fn();
const activateMock: Mock = vi.fn();
const listRuleMock: Mock = vi.fn();
const updateRuleMock: Mock = vi.fn();
const deleteRuleMock: Mock = vi.fn();
const getConfigMock: Mock = vi.fn();
const createConfigMock: Mock = vi.fn();
const updateConfigMock: Mock = vi.fn();

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    models: {
      LinguisticPromptTemplate: {
        list: (...a: unknown[]): Promise<unknown> => listTemplateMock(...a),
      },
      LinguisticRule: {
        list: (...a: unknown[]): Promise<unknown> => listRuleMock(...a),
        update: (...a: unknown[]): Promise<unknown> => updateRuleMock(...a),
        delete: (...a: unknown[]): Promise<unknown> => deleteRuleMock(...a),
      },
      LinguisticConfig: {
        get: (...a: unknown[]): Promise<unknown> => getConfigMock(...a),
        create: (...a: unknown[]): Promise<unknown> => createConfigMock(...a),
        update: (...a: unknown[]): Promise<unknown> => updateConfigMock(...a),
      },
    },
    mutations: {
      savePromptTemplateVersion: (...a: unknown[]): Promise<unknown> => saveVersionMock(...a),
      activatePromptTemplate: (...a: unknown[]): Promise<unknown> => activateMock(...a),
    },
  }),
}));

import {
  listPromptTemplates,
  saveNewTemplateVersion,
  activateTemplate,
  listRules,
  setRuleEnabled,
  deleteRule,
  getLinguisticConfig,
  upsertLinguisticConfig,
  ACTIVE_PROMPT_ID,
  RULE_AUTO_ACTIVATE_THRESHOLD,
  FALLBACK_SYSTEM_PROMPT,
} from './linguistic';

beforeEach(() => {
  [
    listTemplateMock,
    saveVersionMock,
    activateMock,
    listRuleMock,
    updateRuleMock,
    deleteRuleMock,
    getConfigMock,
    createConfigMock,
    updateConfigMock,
  ].forEach((m) => m.mockReset());
});

describe('FALLBACK_SYSTEM_PROMPT', () => {
  it('re-exports the git default and contains the transcript placeholder', () => {
    expect(FALLBACK_SYSTEM_PROMPT).toContain('{{TRANSCRIPT}}');
    expect(FALLBACK_SYSTEM_PROMPT).toContain('EAM Parser');
  });
});

describe('listPromptTemplates', () => {
  it('filters by prompt id with userPool auth and sorts version desc', async () => {
    listTemplateMock.mockResolvedValue({
      data: [
        { id: 'a', promptId: ACTIVE_PROMPT_ID, version: 1, body: 'x', isActive: false },
        { id: 'b', promptId: ACTIVE_PROMPT_ID, version: 3, body: 'y', isActive: true },
        { id: 'c', promptId: ACTIVE_PROMPT_ID, version: 2, body: 'z', isActive: false },
      ],
    });
    const out = await listPromptTemplates();
    expect(out.map((t) => t.version)).toEqual([3, 2, 1]);
    const arg = listTemplateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.authMode).toBe('userPool');
    expect(arg.filter).toEqual({ promptId: { eq: ACTIVE_PROMPT_ID } });
  });

  it('throws when AppSync returns errors', async () => {
    listTemplateMock.mockResolvedValue({ errors: [{ message: 'Unauthorized' }] });
    await expect(listPromptTemplates()).rejects.toThrow(/Unauthorized/);
  });
});

describe('saveNewTemplateVersion', () => {
  it('calls the savePromptTemplateVersion mutation with userPool auth and returns the row', async () => {
    saveVersionMock.mockResolvedValue({
      data: {
        id: `${ACTIVE_PROMPT_ID}#v6`,
        promptId: ACTIVE_PROMPT_ID,
        version: 6,
        body: 'new {{TRANSCRIPT}}',
        isActive: false,
      },
    });
    const out = await saveNewTemplateVersion({ body: 'new {{TRANSCRIPT}}', notes: 'why' });
    expect(out.version).toBe(6);
    const [payload, opts] = saveVersionMock.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({
      promptId: ACTIVE_PROMPT_ID,
      body: 'new {{TRANSCRIPT}}',
      notes: 'why',
    });
    expect(opts.authMode).toBe('userPool');
  });

  it('rejects a body missing the placeholder before calling the mutation', async () => {
    await expect(saveNewTemplateVersion({ body: 'no placeholder' })).rejects.toThrow(
      /\{\{TRANSCRIPT\}\}/,
    );
    expect(saveVersionMock).not.toHaveBeenCalled();
  });

  it('propagates a server error (no silent success)', async () => {
    saveVersionMock.mockResolvedValue({ errors: [{ message: 'boom' }] });
    await expect(saveNewTemplateVersion({ body: '{{TRANSCRIPT}}' })).rejects.toThrow(/boom/);
  });
});

describe('activateTemplate', () => {
  it('calls the activatePromptTemplate mutation with userPool auth and returns the row', async () => {
    activateMock.mockResolvedValue({
      data: { id: 'b', promptId: ACTIVE_PROMPT_ID, version: 2, body: 'y', isActive: true },
    });
    const out = await activateTemplate('b');
    expect(out.isActive).toBe(true);
    const [payload, opts] = activateMock.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({ id: 'b' });
    expect(opts.authMode).toBe('userPool');
  });

  it('throws (not a silent success) when the mutation errors', async () => {
    activateMock.mockResolvedValue({ errors: [{ message: 'conditional check failed' }] });
    await expect(activateTemplate('b')).rejects.toThrow(/conditional check failed/);
  });
});

describe('listRules', () => {
  it('sorts by priority desc and maps fields', async () => {
    listRuleMock.mockResolvedValue({
      data: [
        {
          id: 'r1',
          component: 'TYPE',
          pattern: 'p1',
          confidence: 0.9,
          enabled: true,
          messageType: 'SKYKING',
          priority: 1,
        },
        {
          id: 'r2',
          component: 'SENDER',
          pattern: 'p2',
          confidence: 0.5,
          enabled: false,
          messageType: 'OTHER',
          priority: 9,
        },
      ],
    });
    const out = await listRules();
    expect(out.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(out[0]!.confidence).toBe(0.5);
    expect((listRuleMock.mock.calls[0]![0] as Record<string, unknown>).authMode).toBe('userPool');
  });
});

describe('setRuleEnabled', () => {
  it('updates enabled with userPool auth', async () => {
    updateRuleMock.mockResolvedValue({ data: { id: 'r1' } });
    await setRuleEnabled('r1', false);
    const [payload, opts] = updateRuleMock.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({ id: 'r1', enabled: false });
    expect(opts.authMode).toBe('userPool');
  });

  it('throws on mutation errors', async () => {
    updateRuleMock.mockResolvedValue({ errors: [{ message: 'boom' }] });
    await expect(setRuleEnabled('r1', true)).rejects.toThrow(/boom/);
  });
});

describe('deleteRule', () => {
  it('deletes by id with userPool auth', async () => {
    deleteRuleMock.mockResolvedValue({ data: { id: 'r1' } });
    await deleteRule('r1');
    const [payload, opts] = deleteRuleMock.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({ id: 'r1' });
    expect(opts.authMode).toBe('userPool');
  });
});

describe('constants', () => {
  it('exposes the prompt id and auto-activate threshold', () => {
    expect(ACTIVE_PROMPT_ID).toBe('linguistic-parse-bedrock');
    expect(RULE_AUTO_ACTIVATE_THRESHOLD).toBe(0.85);
  });
});

describe('getLinguisticConfig', () => {
  it('reads a row value by key with userPool auth', async () => {
    getConfigMock.mockResolvedValue({ data: { key: 'thresholds', value: { SKYKING: 0.9 } } });
    const out = await getLinguisticConfig('thresholds');
    expect(out).toEqual({ SKYKING: 0.9 });
    // Regression: authMode is the SECOND arg to model.get (identifier is the
    // first). Spreading it into the identifier object silently drops it and
    // the read 401s against the admin-only LinguisticConfig. The identifier
    // arg must carry ONLY the key; the options arg must carry authMode.
    const idArg = getConfigMock.mock.calls[0]![0] as Record<string, unknown>;
    const optsArg = getConfigMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(idArg.key).toBe('thresholds');
    expect(idArg.authMode).toBeUndefined();
    expect(optsArg.authMode).toBe('userPool');
  });

  it('returns undefined when the row does not exist', async () => {
    getConfigMock.mockResolvedValue({ data: null });
    expect(await getLinguisticConfig('schemas')).toBeUndefined();
  });

  it('throws on read errors', async () => {
    getConfigMock.mockResolvedValue({ errors: [{ message: 'Unauthorized' }] });
    await expect(getLinguisticConfig('thresholds')).rejects.toThrow(/Unauthorized/);
  });
});

describe('upsertLinguisticConfig', () => {
  it('updates an existing row with userPool auth', async () => {
    updateConfigMock.mockResolvedValue({ data: { key: 'thresholds' } });
    await upsertLinguisticConfig('thresholds', { SKYKING: 0.9 }, 'edit');
    expect(createConfigMock).not.toHaveBeenCalled();
    const [payload, opts] = updateConfigMock.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({ key: 'thresholds', value: { SKYKING: 0.9 }, notes: 'edit' });
    expect(opts.authMode).toBe('userPool');
  });

  it('falls back to create when update reports an error (row missing)', async () => {
    updateConfigMock.mockResolvedValue({ errors: [{ message: 'not found' }] });
    createConfigMock.mockResolvedValue({ data: { key: 'schemas' } });
    await upsertLinguisticConfig('schemas', { SKYKING: {} });
    expect(createConfigMock).toHaveBeenCalledTimes(1);
    const [payload] = createConfigMock.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.key).toBe('schemas');
  });

  it('throws when the create fallback also errors', async () => {
    updateConfigMock.mockResolvedValue({ errors: [{ message: 'not found' }] });
    createConfigMock.mockResolvedValue({ errors: [{ message: 'boom' }] });
    await expect(upsertLinguisticConfig('schemas', {})).rejects.toThrow(/boom/);
  });
});
