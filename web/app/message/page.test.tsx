import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MessageDetailRoute from './page';

vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

const searchParams = new URLSearchParams();
vi.mock('next/navigation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => searchParams,
    usePathname: () => '/message',
  };
});

vi.mock('@/lib/messages/query', () => ({
  getMessage: vi.fn().mockResolvedValue({
    id: 'm-1',
    type: 'SKYKING',
    broadcastTs: '2026-05-27T12:00:00Z',
    sender: 'MAINSAIL',
    receiver: 'ANCHOR',
    body: 'PT3 14 AB',
    confidence: 0.9,
    flaggedForReview: false,
    publishedAt: '2026-05-27T12:30:00Z',
    characterCount: 30,
    codewordCount: 0,
  }),
}));
vi.mock('@/lib/messages/recordings', () => ({
  listRecordingsForMessage: vi.fn().mockResolvedValue([
    {
      id: 'r-1',
      frequencyKhz: 11175,
      modulation: 'USB',
      broadcastedAt: '2026-05-27T12:00:00Z',
      transcript: 'PT3 14 AB',
      transcriptionStatus: 'PUBLISHED',
      transcriptionFailed: false,
      durationMs: 4200,
      sdrId: null,
      automated: true,
      webCanonicalKey: null,
      wordTimestampsKey: null,
      peaksJsonKey: null,
    },
  ]),
}));

vi.mock('@/components/player/AudioPlayer', () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
}));

vi.mock('@/components/validation/RevisionPanel', () => ({
  RevisionPanel: () => <div data-testid="revision-panel" />,
}));

vi.mock('@/components/validation/FieldVoteAffordance', () => ({
  FieldVoteAffordance: () => <div data-testid="field-vote-affordance" />,
}));

vi.mock('@/components/account/SessionGreeting', () => ({
  useSessionState: () => ({ loading: false, signedIn: false, username: null }),
}));

describe('MessageDetailRoute', () => {
  beforeEach(() => {
    searchParams.delete('id');
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows a hint when no id is in the URL', () => {
    render(<MessageDetailRoute />);
    expect(screen.getByText(/no message id supplied/i)).toBeInTheDocument();
  });

  it('renders the message + recording list when id is present', async () => {
    searchParams.set('id', 'm-1');
    render(<MessageDetailRoute />);
    await waitFor(() => {
      expect(screen.getAllByText('MAINSAIL').length).toBeGreaterThan(0);
      expect(screen.getByText(/11\.175 MHz · USB/)).toBeInTheDocument();
    });
  });

  it('shows an audio-not-ready placeholder when webCanonicalKey is null', async () => {
    searchParams.set('id', 'm-1');
    render(<MessageDetailRoute />);
    await waitFor(() => {
      expect(screen.getByLabelText('Audio not yet ready')).toBeInTheDocument();
    });
  });
});
