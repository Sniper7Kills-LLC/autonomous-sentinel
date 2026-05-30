import { describe, it, expect, vi, beforeEach } from 'vitest';

type Mock = ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<unknown>>>;
const listTemplateMock: Mock = vi.fn();
const createTemplateMock: Mock = vi.fn();
const updateTemplateMock: Mock = vi.fn();
const listRuleMock: Mock = vi.fn();
const updateRuleMock: Mock = vi.fn();
const deleteRuleMock: Mock = vi.fn();

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: () => ({
    models: {
      LinguisticPromptTemplate: {
        list: (...a: unknown[]): Promise<unknown> => listTemplateMock(...a),
        create: (...a: unknown[]): Promise<unknown> => createTemplateMock(...a),
        update: (...a: unknown[]): Promise<unknown> => updateTemplateMock(...a),
      },
      LinguisticRule: {
        list: (...a: unknown[]): Promise<unknown> => listRuleMock(...a),
        update: (...a: unknown[]): Promise<unknown> => updateRuleMock(...a),
        delete: (...a: unknown[]): Promise<unknown> => deleteRuleMock(...a),
      },
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
  ACTIVE_PROMPT_ID,
  RULE_AUTO_ACTIVATE_THRESHOLD,
  FALLBACK_SYSTEM_PROMPT,
  type DisplayTemplate,
} from './linguistic';

beforeEach(() => {
  [
    listTemplateMock,
    createTemplateMock,
    updateTemplateMock,
    listRuleMock,
    updateRuleMock,
    deleteRuleMock,
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
  const existing: DisplayTemplate[] = [
    {
      id: 'a',
      promptId: ACTIVE_PROMPT_ID,
      version: 2,
      body: 'x',
      isActive: true,
      notes: null,
      createdBy: null,
      createdAt: null,
    },
    {
      id: 'b',
      promptId: ACTIVE_PROMPT_ID,
      version: 5,
      body: 'y',
      isActive: false,
      notes: null,
      createdBy: null,
      createdAt: null,
    },
  ];

  it('bumps to max(version)+1 and creates an inactive row', async () => {
    createTemplateMock.mockResolvedValue({
      data: {
        id: 'n',
        promptId: ACTIVE_PROMPT_ID,
        version: 6,
        body: 'new {{TRANSCRIPT}}',
        isActive: false,
      },
    });
    const out = await saveNewTemplateVersion({ body: 'new {{TRANSCRIPT}}', existing });
    expect(out.version).toBe(6);
    const [payload, opts] = createTemplateMock.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload.version).toBe(6);
    expect(payload.isActive).toBe(false);
    expect(opts.authMode).toBe('userPool');
  });

  it('rejects a body missing the placeholder before any create', async () => {
    await expect(saveNewTemplateVersion({ body: 'no placeholder', existing })).rejects.toThrow(
      /\{\{TRANSCRIPT\}\}/,
    );
    expect(createTemplateMock).not.toHaveBeenCalled();
  });

  it('starts at version 1 when no templates exist', async () => {
    createTemplateMock.mockResolvedValue({
      data: { id: 'n', version: 1, body: '{{TRANSCRIPT}}', isActive: false },
    });
    await saveNewTemplateVersion({ body: '{{TRANSCRIPT}}', existing: [] });
    const [payload] = createTemplateMock.mock.calls[0]! as [Record<string, unknown>];
    expect(payload.version).toBe(1);
  });
});

describe('activateTemplate', () => {
  const templates: DisplayTemplate[] = [
    {
      id: 'a',
      promptId: ACTIVE_PROMPT_ID,
      version: 1,
      body: 'x',
      isActive: true,
      notes: null,
      createdBy: null,
      createdAt: null,
    },
    {
      id: 'b',
      promptId: ACTIVE_PROMPT_ID,
      version: 2,
      body: 'y',
      isActive: false,
      notes: null,
      createdBy: null,
      createdAt: null,
    },
  ];

  it('deactivates the prior active row then activates the target', async () => {
    updateTemplateMock.mockResolvedValue({ data: { id: 'x' } });
    await activateTemplate('b', templates);
    const calls = updateTemplateMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls).toEqual([
      { id: 'a', isActive: false },
      { id: 'b', isActive: true },
    ]);
  });

  it('does not deactivate the target even if it was already active', async () => {
    updateTemplateMock.mockResolvedValue({ data: { id: 'x' } });
    await activateTemplate('a', templates);
    const calls = updateTemplateMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls).toEqual([{ id: 'a', isActive: true }]);
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
