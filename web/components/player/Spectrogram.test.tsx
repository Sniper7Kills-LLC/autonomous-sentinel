import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Spectrogram, isHeavyCompute } from './Spectrogram';

const getRecordingAssetUrlMock = vi.fn<(key: string) => Promise<string>>();
vi.mock('@/lib/audio/url', () => ({
  getRecordingAssetUrl: (key: string) => getRecordingAssetUrlMock(key),
}));

describe('Spectrogram', () => {
  beforeEach(() => {
    getRecordingAssetUrlMock.mockReset();
    getRecordingAssetUrlMock.mockImplementation((key) =>
      Promise.resolve(`https://signed.example.test/${key}`),
    );
    // Minimal fetch stub — returns an empty arraybuffer; decode is stubbed below.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        }),
      ),
    );
    // jsdom has no real OfflineAudioContext / AudioContext — stub a decoder
    // that yields a tiny mono buffer so the compute path runs without throwing.
    const fakeBuffer = {
      numberOfChannels: 1,
      length: 1024,
      sampleRate: 16000,
      getChannelData: () => new Float32Array(1024),
    };
    class FakeAudioContext {
      decodeAudioData(): Promise<unknown> {
        return Promise.resolve(fakeBuffer);
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // Canvas 2D context stub.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the reveal toggle and hides the canvas by default', () => {
    render(
      <Spectrogram
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        currentTime={0}
        duration={10}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /view spectrogram/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/spectrogram/i)).not.toBeInTheDocument();
  });

  it('reveals the canvas container on toggle and flips the button label', async () => {
    render(
      <Spectrogram
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        currentTime={0}
        duration={10}
        onSeek={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /view spectrogram/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /hide spectrogram/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/spectrogram/i)).toBeInTheDocument();
  });

  it('removes the canvas container when toggled off again', async () => {
    render(
      <Spectrogram
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        currentTime={0}
        duration={10}
        onSeek={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /view spectrogram/i }));
    await screen.findByRole('button', { name: /hide spectrogram/i });
    fireEvent.click(screen.getByRole('button', { name: /hide spectrogram/i }));
    await waitFor(() => {
      expect(screen.queryByLabelText(/^spectrogram/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /view spectrogram/i })).toBeInTheDocument();
  });

  it('seeks proportionally when the spectrogram is clicked', async () => {
    const onSeek = vi.fn();
    render(
      <Spectrogram
        recordingId="rec-1"
        webCanonicalKey="recordings/web/rec-1.opus"
        currentTime={0}
        duration={20}
        onSeek={onSeek}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /view spectrogram/i }));
    const region = await screen.findByLabelText(/spectrogram/i);
    // jsdom reports 0-width rects, so mock the bounding box for the click math.
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      top: 0,
      height: 96,
      right: 100,
      bottom: 96,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.click(region, { clientX: 50 });
    expect(onSeek).toHaveBeenCalledWith(10);
  });
});

describe('isHeavyCompute', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags large sample counts as heavy', () => {
    // ~10 minutes at 48kHz vastly exceeds the frame threshold.
    expect(isHeavyCompute(48000 * 600)).toBe(true);
  });

  it('does not flag a short clip on a normal-memory device', () => {
    vi.stubGlobal('navigator', { deviceMemory: 8 });
    expect(isHeavyCompute(16000)).toBe(false);
  });

  it('flags any clip when deviceMemory is below 4', () => {
    vi.stubGlobal('navigator', { deviceMemory: 2 });
    expect(isHeavyCompute(16000)).toBe(true);
  });
});
