import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DebugDetailsPanel } from './DebugDetailsPanel';
import type { DisplayMessage } from '@/lib/messages/types';
import type { DisplayRecording, LinguisticAttempt } from '@/lib/messages/recordings';

const groupsMock = vi.fn<() => Promise<string[]>>();
vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchCallerGroups: (): Promise<string[]> => groupsMock(),
  };
});

const rulesMock = vi.fn<() => Promise<unknown>>();
vi.mock('@/lib/messages/rules', () => ({
  listRulesForType: (): Promise<unknown> => rulesMock(),
}));

const message: DisplayMessage = {
  id: 'msg-1',
  type: 'SKYKING',
  broadcastTs: '2026-05-30T00:00:00Z',
  sender: 'MAINSAIL',
  receiver: 'SKYKING',
  body: 'SKYKING SKYKING DO NOT ANSWER',
  confidence: 0.91,
  flaggedForReview: false,
  publishedAt: '2026-05-30T00:01:00Z',
  submitterId: null,
};

const attempt: LinguisticAttempt = {
  provider: 'rules',
  success: true,
  promptVersion: 3,
  promptHash: 'ph',
  resultHash: 'rh',
  ts: '2026-05-30T00:00:30Z',
};

const recording: DisplayRecording = {
  id: 'rec-1',
  frequencyKhz: 11175,
  modulation: 'USB',
  broadcastedAt: '2026-05-30T00:00:00Z',
  transcript: 'SKYKING SKYKING DO NOT ANSWER ALPHA BRAVO',
  transcripts: [
    {
      backend: 'whisper-local',
      transcript: 'SKYKING SKYKING DO NOT ANSWER OXTRA BRAVO',
      transcriptionConfidence: 0.64,
    },
    {
      backend: 'amazon-transcribe',
      transcript: 'SKYKING SKYKING DO NOT ANSWER ALPHA BRAVO',
      transcriptionConfidence: 0.9,
    },
  ],
  transcriptionStatus: 'PUBLISHED',
  transcriptionFailed: false,
  durationMs: 12000,
  sdrId: null,
  uploaderId: null,
  automated: true,
  webCanonicalKey: 'k',
  wordTimestampsKey: null,
  peaksJsonKey: null,
  transcriptionConfidence: 0.64,
  linguisticAttempts: [attempt],
};

describe('DebugDetailsPanel', () => {
  beforeEach(() => {
    groupsMock.mockReset();
    rulesMock.mockReset();
    rulesMock.mockResolvedValue([]);
  });

  it('is hidden for a non-admin / non-moderator session', async () => {
    groupsMock.mockResolvedValue(['member']);
    render(<DebugDetailsPanel message={message} recordings={[recording]} />);
    // Give the gate effect a chance to run, then assert nothing rendered.
    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('debug-details')).not.toBeInTheDocument();
    expect(screen.queryByText('Debug details')).not.toBeInTheDocument();
  });

  it('is hidden while the group lookup is unresolved/failing', async () => {
    groupsMock.mockRejectedValue(new Error('no session'));
    render(<DebugDetailsPanel message={message} recordings={[recording]} />);
    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('debug-details')).not.toBeInTheDocument();
  });

  it('renders transcript + attempts + parsed fields for an admin session', async () => {
    groupsMock.mockResolvedValue(['admin']);
    rulesMock.mockResolvedValue([
      {
        id: 'rule-1',
        component: 'TYPE',
        pattern: 'SKYKING\\s+SKYKING',
        confidence: 0.9,
        enabled: true,
        messageType: 'SKYKING',
        appliesToType: null,
        priority: 10,
      },
    ]);
    render(<DebugDetailsPanel message={message} recordings={[recording]} />);

    await waitFor(() => expect(screen.getByTestId('debug-details')).toBeInTheDocument());
    expect(screen.getByText('Debug details')).toBeInTheDocument();
    // Raw transcript — both ASR backends shown side-by-side (#593)
    expect(screen.getByText(/SKYKING SKYKING DO NOT ANSWER ALPHA BRAVO/)).toBeInTheDocument();
    expect(screen.getByText(/SKYKING SKYKING DO NOT ANSWER OXTRA BRAVO/)).toBeInTheDocument();
    expect(screen.getByText(/whisper-local · confidence 0\.64/)).toBeInTheDocument();
    expect(screen.getByText(/amazon-transcribe · confidence 0\.90/)).toBeInTheDocument();
    // Attempt row
    expect(screen.getByText('rules')).toBeInTheDocument();
    // Parsed fields
    expect(screen.getByText('MAINSAIL')).toBeInTheDocument();
    expect(screen.getByText('0.91')).toBeInTheDocument();
    // Transcription confidence (#581) — distinct from the parse confidence.
    // 0.64 now appears both on the recording-level label and the
    // whisper-local backend block (#593), so match all occurrences.
    expect(screen.getByText(/Transcription confidence:/)).toBeInTheDocument();
    expect(screen.getAllByText(/0\.64/).length).toBeGreaterThanOrEqual(1);
    // Rules section with caveat label. Assert the caveat AND the rule
    // pattern in one waitFor — both land in the same async rules render,
    // so a slow CI tick must not fail the second (pattern) assertion
    // before the rules section has fully painted (flaky web-checks fix).
    await waitFor(() => {
      expect(screen.getByText(/not a per-message link/i)).toBeInTheDocument();
      expect(screen.getByText('SKYKING\\s+SKYKING')).toBeInTheDocument();
    });
  });

  it('shows the panel for moderators too', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    render(<DebugDetailsPanel message={message} recordings={[recording]} />);
    await waitFor(() => expect(screen.getByTestId('debug-details')).toBeInTheDocument());
  });

  it('renders a fallback note when rule loading fails', async () => {
    groupsMock.mockResolvedValue(['admin']);
    rulesMock.mockRejectedValue(new Error('not authorized'));
    render(<DebugDetailsPanel message={message} recordings={[recording]} />);
    await waitFor(() => expect(screen.getByTestId('debug-details')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/could not load rules/i)).toBeInTheDocument());
  });
});
