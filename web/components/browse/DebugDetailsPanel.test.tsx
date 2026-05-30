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
  characterCount: 30,
  codewordCount: 4,
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
  transcriptionStatus: 'PUBLISHED',
  transcriptionFailed: false,
  durationMs: 12000,
  sdrId: null,
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
    // Raw transcript
    expect(screen.getByText(/SKYKING SKYKING DO NOT ANSWER ALPHA BRAVO/)).toBeInTheDocument();
    // Attempt row
    expect(screen.getByText('rules')).toBeInTheDocument();
    // Parsed fields
    expect(screen.getByText('MAINSAIL')).toBeInTheDocument();
    expect(screen.getByText('0.91')).toBeInTheDocument();
    // Transcription confidence (#581) — distinct from the parse confidence
    expect(screen.getByText(/Transcription confidence:/)).toBeInTheDocument();
    expect(screen.getByText(/0\.64/)).toBeInTheDocument();
    // Rules section with caveat label
    await waitFor(() => expect(screen.getByText(/not a per-message link/i)).toBeInTheDocument());
    expect(screen.getByText('SKYKING\\s+SKYKING')).toBeInTheDocument();
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
