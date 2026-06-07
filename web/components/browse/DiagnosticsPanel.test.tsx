import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import type { DisplayTrace } from '@/lib/messages/traces';

let callerGroups: { groups: string[]; loading: boolean } = { groups: [], loading: false };
vi.mock('@/components/auth/AuthProvider', () => ({
  useCallerGroups: () => callerGroups,
}));

const listTracesForRecording = vi.fn<(id: string) => Promise<DisplayTrace[]>>();
const fetchTraceOverflow = vi.fn<(key: string) => Promise<string>>();
vi.mock('@/lib/messages/traces', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listTracesForRecording: (id: string) => listTracesForRecording(id),
  fetchTraceOverflow: (key: string) => fetchTraceOverflow(key),
}));

interface AdminRuleStub {
  id: string;
  enabled: boolean;
}
const listRules = vi.fn<() => Promise<AdminRuleStub[]>>();
const setRuleEnabled = vi.fn<(id: string, enabled: boolean) => Promise<void>>();
vi.mock('@/lib/admin/linguistic', () => ({
  listRules: () => listRules(),
  setRuleEnabled: (id: string, enabled: boolean) => setRuleEnabled(id, enabled),
}));

interface CallsignStub {
  id: string;
  normalized: string;
  variants: string[];
  source: 'LEGACY' | 'ADMIN' | 'AI_SUGGESTED' | null;
  confidence: number | null;
  approved: boolean;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
const findCallsignByNormalized = vi.fn<(n: string) => Promise<CallsignStub | null>>();
const approveCallsign = vi.fn<(id: string) => Promise<CallsignStub>>();
const deleteCallsign = vi.fn<(id: string) => Promise<void>>();
vi.mock('@/lib/admin/callsigns', () => ({
  findCallsignByNormalized: (n: string) => findCallsignByNormalized(n),
  approveCallsign: (id: string) => approveCallsign(id),
  deleteCallsign: (id: string) => deleteCallsign(id),
}));

function callsign(overrides: Partial<CallsignStub> = {}): CallsignStub {
  return {
    id: 'cs-1',
    normalized: 'MAINSAIL',
    variants: [],
    source: 'AI_SUGGESTED',
    confidence: null,
    approved: false,
    notes: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function trace(overrides: Partial<DisplayTrace> = {}): DisplayTrace {
  return {
    id: 'trace-1',
    recordingId: 'rec-1',
    runAt: '2026-06-06T00:00:00.000Z',
    triggerBackend: 'whisper-local',
    transcriptSnapshot: 'SKYKING ABC',
    rulesEvaluated: [
      {
        ruleId: 'r1',
        component: 'TYPE',
        messageType: 'SKYKING',
        appliesToType: null,
        pattern: 'SKYKING',
        confidence: 0.9,
        matched: true,
        matchedText: 'SKYKING',
        captures: { sender: 'MAINSAIL' },
      },
    ],
    rulesOutcome: null,
    bedrockInvoked: true,
    bedrockModelId: 'us.anthropic.claude-opus-4-8',
    bedrockPromptVersion: 1,
    bedrockPromptHash: 'ph',
    bedrockRenderedPrompt: 'PROMPT v1',
    bedrockRawResponse: { output: { message: {} } },
    bedrockParsed: { type: 'SKYKING', confidence: 0.7 },
    bedrockProposedRules: [],
    finalResult: { type: 'SKYKING', source: 'bedrock' },
    attemptSuccess: true,
    resultHash: 'rh',
    promptHash: 'ph',
    overflowKeys: {},
    truncated: false,
    ...overrides,
  };
}

describe('DiagnosticsPanel (#745)', () => {
  beforeEach(() => {
    callerGroups = { groups: [], loading: false };
    listTracesForRecording.mockReset();
    fetchTraceOverflow.mockReset();
    listRules.mockReset();
    listRules.mockResolvedValue([]);
    setRuleEnabled.mockReset();
    setRuleEnabled.mockResolvedValue();
    findCallsignByNormalized.mockReset();
    findCallsignByNormalized.mockResolvedValue(null);
    approveCallsign.mockReset();
    approveCallsign.mockResolvedValue(callsign({ approved: true }));
    deleteCallsign.mockReset();
    deleteCallsign.mockResolvedValue();
  });

  it('renders nothing for a member (no diagnostics access)', () => {
    callerGroups = { groups: ['member'], loading: false };
    render(<DiagnosticsPanel recordingId="rec-1" />);
    expect(screen.queryByTestId('diagnostics-open')).not.toBeInTheDocument();
  });

  it('shows the trigger for the diagnostics group and lazy-fetches only on open', async () => {
    callerGroups = { groups: ['diagnostics'], loading: false };
    listTracesForRecording.mockResolvedValue([trace()]);
    render(<DiagnosticsPanel recordingId="rec-1" />);

    // Not fetched until opened.
    expect(listTracesForRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    await waitFor(() => expect(listTracesForRecording).toHaveBeenCalledWith('rec-1'));
    expect(screen.getByTestId('rules-table')).toBeInTheDocument();
  });

  it('is available to moderators and admins too', () => {
    callerGroups = { groups: ['moderator'], loading: false };
    render(<DiagnosticsPanel recordingId="rec-1" />);
    expect(screen.getByTestId('diagnostics-open')).toBeInTheDocument();
  });

  it('renders the rules table, bedrock prompt + final parse for the selected run', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([trace()]);
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    await waitFor(() =>
      expect(screen.getByTestId('bedrock-prompt')).toHaveTextContent('PROMPT v1'),
    );
    expect(screen.getByTestId('rules-table')).toHaveTextContent('SKYKING');
    expect(screen.getByTestId('final-result')).toHaveTextContent('bedrock');
  });

  it('shows an empty state when there are no traces', async () => {
    callerGroups = { groups: ['diagnostics'], loading: false };
    listTracesForRecording.mockResolvedValue([]);
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    await waitFor(() => expect(screen.getByText(/no diagnostic traces/i)).toBeInTheDocument());
  });

  it('diffs two runs when a compare run is selected', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    const older = trace({
      id: 'trace-0',
      runAt: '2026-06-05T00:00:00.000Z',
      bedrockRenderedPrompt: 'PROMPT v0',
      finalResult: { type: 'OTHER', source: 'bedrock' },
    });
    listTracesForRecording.mockResolvedValue([trace(), older]); // newest first
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    await waitFor(() => expect(screen.getByTestId('run-select')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('compare-select'), { target: { value: 'trace-0' } });
    expect(screen.getByTestId('run-diff')).toBeInTheDocument();
    // The diff renders added/removed segments (v1 vs v0, SKYKING vs OTHER).
    expect(screen.getByTestId('run-diff')).toHaveTextContent('OTHER');
  });

  it('shows a truncated-field placeholder when the trace was size-guarded', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({ truncated: true, bedrockRenderedPrompt: null, bedrockRawResponse: null }),
    ]);
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    await waitFor(() =>
      expect(screen.getByTestId('bedrock-prompt')).toHaveTextContent(/dropped — trace truncated/i),
    );
  });

  it('loads a spilled field from S3 on demand (#749)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({
        truncated: true,
        bedrockRenderedPrompt: null,
        overflowKeys: { renderedPrompt: 'diagnostics/rec-1/run-prompt.txt' },
      }),
    ]);
    fetchTraceOverflow.mockResolvedValue('FULL PROMPT FROM S3');
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    // Offloaded → shows a load button, not the text, until clicked (lazy).
    const promptField = await screen.findByTestId('bedrock-prompt');
    expect(promptField).toHaveTextContent(/offloaded to s3/i);
    expect(fetchTraceOverflow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /load from s3/i }));
    await waitFor(() =>
      expect(fetchTraceOverflow).toHaveBeenCalledWith('diagnostics/rec-1/run-prompt.txt'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('bedrock-prompt')).toHaveTextContent('FULL PROMPT FROM S3'),
    );
  });

  it('surfaces an error when the S3 spill fetch fails (#749)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({
        truncated: true,
        bedrockRenderedPrompt: null,
        overflowKeys: { renderedPrompt: 'diagnostics/rec-1/run-prompt.txt' },
      }),
    ]);
    fetchTraceOverflow.mockRejectedValue(new Error('signed URL expired'));
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    await screen.findByTestId('bedrock-prompt');
    fireEvent.click(screen.getByRole('button', { name: /load from s3/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/signed url expired/i));
  });

  it('lets an admin disable a rule inline from the rules table (#746)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([trace()]); // rule id 'r1'
    listRules.mockResolvedValue([{ id: 'r1', enabled: true }]);
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    const toggle = await screen.findByTestId('rule-toggle-r1');
    expect(toggle).toHaveTextContent('Disable');
    fireEvent.click(toggle);
    await waitFor(() => expect(setRuleEnabled).toHaveBeenCalledWith('r1', false));
    await waitFor(() => expect(screen.getByTestId('rule-toggle-r1')).toHaveTextContent('Enable'));
  });

  it('does NOT show rule toggles to a non-admin diagnostics viewer (#746)', async () => {
    callerGroups = { groups: ['diagnostics'], loading: false };
    listTracesForRecording.mockResolvedValue([trace()]);
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    await screen.findByTestId('rules-table');
    expect(listRules).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rule-toggle-r1')).not.toBeInTheDocument();
  });

  it('links an admin to the full Linguistic Logic config page (#746)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([trace()]);
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));
    const link = await screen.findByRole('link', { name: /linguistic logic config/i });
    expect(link).toHaveAttribute('href', '/admin/linguistic');
  });

  it('looks up the parse callsigns and skips ALL STATIONS (#777)', async () => {
    callerGroups = { groups: ['diagnostics'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({ finalResult: { sender: 'mainsail', receiver: 'ALL STATIONS', source: 'bedrock' } }),
    ]);
    findCallsignByNormalized.mockResolvedValue(callsign());
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    await screen.findByTestId('callsign-review');
    await waitFor(() => expect(findCallsignByNormalized).toHaveBeenCalledWith('MAINSAIL'));
    // Collective receiver is never a callsign — no lookup, no chip.
    expect(findCallsignByNormalized).not.toHaveBeenCalledWith('ALL STATIONS');
    expect(screen.getByTestId('callsign-chip-MAINSAIL')).toBeInTheDocument();
    expect(screen.queryByTestId('callsign-chip-ALL STATIONS')).not.toBeInTheDocument();
  });

  it('shows confirm/reject for a pending suggested callsign to an admin (#777)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({ finalResult: { sender: 'MAINSAIL', source: 'bedrock' } }),
    ]);
    findCallsignByNormalized.mockResolvedValue(callsign({ id: 'cs-9', approved: false }));
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    const confirm = await screen.findByTestId('callsign-confirm-MAINSAIL');
    fireEvent.click(confirm);
    await waitFor(() => expect(approveCallsign).toHaveBeenCalledWith('cs-9'));
    await waitFor(() =>
      expect(screen.getByTestId('callsign-state-MAINSAIL')).toHaveTextContent(/in dictionary/i),
    );
  });

  it('rejects a suggested callsign on demand (#777)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({ finalResult: { sender: 'MAINSAIL', source: 'bedrock' } }),
    ]);
    findCallsignByNormalized.mockResolvedValue(callsign({ id: 'cs-9', approved: false }));
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    const reject = await screen.findByTestId('callsign-reject-MAINSAIL');
    fireEvent.click(reject);
    await waitFor(() => expect(deleteCallsign).toHaveBeenCalledWith('cs-9'));
    await waitFor(() =>
      expect(screen.getByTestId('callsign-state-MAINSAIL')).toHaveTextContent(/rejected/i),
    );
  });

  it('does NOT offer confirm/reject to a non-admin diagnostics viewer (#777)', async () => {
    callerGroups = { groups: ['diagnostics'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({ finalResult: { sender: 'MAINSAIL', source: 'bedrock' } }),
    ]);
    findCallsignByNormalized.mockResolvedValue(callsign({ approved: false }));
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    await screen.findByTestId('callsign-chip-MAINSAIL');
    await waitFor(() =>
      expect(screen.getByTestId('callsign-state-MAINSAIL')).toHaveTextContent(/pending review/i),
    );
    expect(screen.queryByTestId('callsign-confirm-MAINSAIL')).not.toBeInTheDocument();
  });

  it('marks an already-approved callsign as in-dictionary with no actions (#777)', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    listTracesForRecording.mockResolvedValue([
      trace({ finalResult: { sender: 'MAINSAIL', source: 'bedrock' } }),
    ]);
    findCallsignByNormalized.mockResolvedValue(callsign({ source: 'LEGACY', approved: true }));
    render(<DiagnosticsPanel recordingId="rec-1" />);
    fireEvent.click(screen.getByTestId('diagnostics-open'));

    await screen.findByTestId('callsign-chip-MAINSAIL');
    await waitFor(() =>
      expect(screen.getByTestId('callsign-state-MAINSAIL')).toHaveTextContent(/in dictionary/i),
    );
    expect(screen.queryByTestId('callsign-confirm-MAINSAIL')).not.toBeInTheDocument();
  });
});
