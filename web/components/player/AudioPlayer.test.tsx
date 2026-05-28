import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AudioPlayer } from './AudioPlayer';

const getRecordingAssetUrlMock = vi.fn<(key: string) => Promise<string>>();
vi.mock('@/lib/audio/url', () => ({
  getRecordingAssetUrl: (key: string) => getRecordingAssetUrlMock(key),
}));

const wsListeners = new Map<string, ((arg?: unknown) => void)[]>();
const wsApi = {
  on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
    const list = wsListeners.get(event) ?? [];
    list.push(handler);
    wsListeners.set(event, list);
  }),
  destroy: vi.fn(),
  playPause: vi.fn().mockResolvedValue(undefined),
  getDuration: vi.fn().mockReturnValue(12.5),
  setTime: vi.fn(),
};

vi.mock('wavesurfer.js', () => ({
  default: {
    create: vi.fn(() => wsApi),
  },
}));

function fireWs(event: string, arg?: unknown) {
  act(() => {
    for (const h of wsListeners.get(event) ?? []) h(arg);
  });
}

describe('AudioPlayer', () => {
  beforeEach(() => {
    wsListeners.clear();
    getRecordingAssetUrlMock.mockReset();
    wsApi.on.mockClear();
    wsApi.destroy.mockClear();
    wsApi.playPause.mockClear();
    wsApi.setTime.mockClear();
    getRecordingAssetUrlMock.mockImplementation((key: string) =>
      Promise.resolve(`https://signed.example.test/${key}?sig=test`),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('peaks')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ peaks: [0.1, 0.4, 0.9, 0.4, 0.1] }),
          });
        }
        if (url.includes('words')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                { word: 'SKYKING', start: 0, end: 1.2 },
                { word: 'PT3', start: 1.4, end: 1.7 },
              ]),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function waitForWavesurferMount() {
    // `assets` settle on a separate frame from the wavesurfer
    // `useEffect`, so wait for the `on('ready', ...)` registration
    // to land before firing synthetic events.
    await screen.findByRole('link', { name: /download \.opus/i });
    await waitFor(() => {
      expect(wsApi.on).toHaveBeenCalledWith('ready', expect.any(Function));
    });
  }

  it('renders a disabled Play button until wavesurfer reports ready', async () => {
    render(
      <AudioPlayer
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        peaksJsonKey="recordings/web/rec-1.peaks.json"
        wordTimestampsKey="recordings/web/rec-1.words.json"
        transcript="SKYKING PT3"
      />,
    );
    await waitForWavesurferMount();
    const btn = screen.getByRole('button', { name: /play recording/i });
    expect(btn).toBeDisabled();
    fireWs('ready');
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
  });

  it('toggles wavesurfer playPause on click', async () => {
    render(<AudioPlayer recordingId="rec-1" webCanonicalKey="recordings/web/rec-1.opus" />);
    await waitForWavesurferMount();
    fireWs('ready');
    fireEvent.click(screen.getByRole('button', { name: /play recording/i }));
    expect(wsApi.playPause).toHaveBeenCalledTimes(1);
  });

  it('updates the displayed time on wavesurfer timeupdate', async () => {
    render(<AudioPlayer recordingId="rec-1" webCanonicalKey="recordings/web/rec-1.opus" />);
    await waitForWavesurferMount();
    fireWs('ready');
    fireWs('timeupdate', 65);
    await waitFor(() => {
      expect(screen.getByText('1:05 / 0:12')).toBeInTheDocument();
    });
  });

  it('renders the synchronised transcript with the active word highlighted', async () => {
    render(
      <AudioPlayer
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        wordTimestampsKey="recordings/web/rec-1.words.json"
      />,
    );
    await waitForWavesurferMount();
    const pane = await screen.findByLabelText('Synchronised transcript');
    expect(pane).toBeInTheDocument();
    fireWs('ready');
    fireWs('timeupdate', 0.5);
    await waitFor(() => {
      const skyking = screen.getByRole('button', { name: /skyking/i });
      expect(skyking).toHaveAttribute('aria-current', 'true');
    });
  });

  it('seeks to the word start when a transcript word is clicked', async () => {
    render(
      <AudioPlayer
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        wordTimestampsKey="recordings/web/rec-1.words.json"
      />,
    );
    await waitForWavesurferMount();
    await screen.findByLabelText('Synchronised transcript');
    fireWs('ready');
    fireEvent.click(screen.getByRole('button', { name: /pt3/i }));
    expect(wsApi.setTime).toHaveBeenCalledWith(1.4);
  });

  it('falls back to plain transcript when word timestamps are absent', async () => {
    render(
      <AudioPlayer
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        transcript="ALPHA BRAVO"
      />,
    );
    expect(await screen.findByLabelText('Transcript (unsynchronised)')).toBeInTheDocument();
  });

  it('renders an error banner when the URL fetch rejects', async () => {
    getRecordingAssetUrlMock.mockImplementationOnce(() =>
      Promise.reject(new Error('storage timeout')),
    );
    render(<AudioPlayer recordingId="rec-1" webCanonicalKey="recordings/web/rec-1.opus" />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/storage timeout/i);
    });
  });
});
