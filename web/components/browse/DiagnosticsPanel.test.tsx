import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import type { DisplayTrace } from '@/lib/messages/traces';

let callerGroups: { groups: string[]; loading: boolean } = { groups: [], loading: false };
vi.mock('@/components/auth/AuthProvider', () => ({
  useCallerGroups: () => callerGroups,
}));

const listTracesForRecording = vi.fn<(id: string) => Promise<DisplayTrace[]>>();
vi.mock('@/lib/messages/traces', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listTracesForRecording: (id: string) => listTracesForRecording(id),
}));

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
});
