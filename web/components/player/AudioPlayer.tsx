'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { getRecordingAssetUrl } from '@/lib/audio/url';
import {
  parsePeaks,
  parseWordTimestamps,
  findActiveWord,
  type PeaksData,
  type WordTimestamp,
} from '@/lib/audio/sidecars';
import { Spectrogram } from './Spectrogram';
import styles from './AudioPlayer.module.css';

interface AudioPlayerProps {
  /** Display label for assistive tech + the download link. */
  recordingId: string;
  /** S3 key for the Opus canonical (required for playback). */
  webCanonicalKey: string;
  /** Optional sidecar key for downsampled waveform peaks. */
  peaksJsonKey?: string | null;
  /** Optional sidecar key for word-level timestamps. */
  wordTimestampsKey?: string | null;
  /** Optional plain-text transcript (fallback when no word timestamps). */
  transcript?: string | null;
}

interface ResolvedAssets {
  audioUrl: string;
  peaks: PeaksData | null;
  words: WordTimestamp[];
}

/**
 * `<AudioPlayer>` — composite player covering #88 (HTML5 base + Opus
 * playback), #89 (waveform via wavesurfer.js), and #92 (scrub-to-text
 * sync via word-level timestamps).
 *
 * Lazy-loads the audio + sidecar JSON only when the component mounts;
 * the detail page can render multiple recording panels without paying
 * the bandwidth tax up-front for the ones below the fold.
 */
export function AudioPlayer({
  recordingId,
  webCanonicalKey,
  peaksJsonKey,
  wordTimestampsKey,
  transcript,
}: AudioPlayerProps) {
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [assets, setAssets] = useState<ResolvedAssets | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    void (async () => {
      try {
        const audioUrl = await getRecordingAssetUrl(webCanonicalKey);
        const [peaks, words] = await Promise.all([
          peaksJsonKey ? fetchPeaks(peaksJsonKey).catch(() => null) : Promise.resolve(null),
          wordTimestampsKey
            ? fetchWordTimestamps(wordTimestampsKey).catch(() => [] as WordTimestamp[])
            : Promise.resolve([] as WordTimestamp[]),
        ]);
        if (!cancelled) {
          setAssets({ audioUrl, peaks, words });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [webCanonicalKey, peaksJsonKey, wordTimestampsKey]);

  useEffect(() => {
    if (!assets || !waveformRef.current) return;
    // Defensive destroy in case a previous wavesurfer instance is
    // still attached — React.StrictMode double-invocation or a
    // rapid `assets` flip could otherwise leak one of the two
    // wavesurfer objects.
    wavesurferRef.current?.destroy();
    const ws = WaveSurfer.create({
      container: waveformRef.current,
      url: assets.audioUrl,
      // Render with precomputed peaks when available — avoids the
      // client-side decode pass that would otherwise block first paint.
      peaks: assets.peaks ? [assets.peaks.peaks] : undefined,
      duration: assets.peaks?.sampleRate
        ? assets.peaks.peaks.length / assets.peaks.sampleRate
        : undefined,
      waveColor: 'rgba(120, 144, 156, 0.55)',
      progressColor: 'var(--color-accent)',
      cursorColor: 'var(--text-1)',
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      height: 96,
      backend: 'MediaElement',
    });
    wavesurferRef.current = ws;
    // Mount guard — every handler short-circuits once the cleanup has
    // nulled the ref. Stops late `ready` / `timeupdate` events
    // (and the React-18 unmounted-setState warning) from firing
    // against the destroyed instance.
    const isLive = () => wavesurferRef.current === ws;
    ws.on('ready', () => {
      if (!isLive()) return;
      setReady(true);
      setDuration(ws.getDuration());
    });
    ws.on('play', () => {
      if (isLive()) setPlaying(true);
    });
    ws.on('pause', () => {
      if (isLive()) setPlaying(false);
    });
    ws.on('finish', () => {
      if (isLive()) setPlaying(false);
    });
    ws.on('timeupdate', (t) => {
      if (isLive()) setCurrentTime(t);
    });
    ws.on('error', (err: unknown) => {
      if (isLive()) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      wavesurferRef.current = null;
      ws.destroy();
    };
  }, [assets]);

  const togglePlay = useCallback(() => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    void ws.playPause();
  }, []);

  const seek = useCallback((time: number) => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    const total = ws.getDuration();
    if (total > 0) {
      ws.setTime(time);
    }
  }, []);

  // Resolve a fresh signed URL on each click instead of baking the initial
  // `assets.audioUrl` into the href — the initial URL TTL can lapse on a
  // long-lived page before a user clicks Download. Extracted to a handler
  // (vs an inline IIFE in JSX) so React Compiler can optimise the render
  // (@eslint-react/unsupported-syntax).
  const handleDownload = useCallback(async () => {
    try {
      const fresh = await getRecordingAssetUrl(webCanonicalKey);
      const a = document.createElement('a');
      a.href = fresh;
      a.download = `${recordingId}.opus`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [webCanonicalKey, recordingId]);

  const activeWordIdx = useMemo(
    () => (assets ? findActiveWord(assets.words, currentTime) : -1),
    [assets, currentTime],
  );

  if (error) {
    return (
      <div className={styles.error} role="alert">
        Audio unavailable: {error}
      </div>
    );
  }

  return (
    <div className={styles.player} data-recording-id={recordingId}>
      <div className={styles.waveformWrap}>
        {!assets && <div className={styles.waveformEmpty}>Loading audio…</div>}
        <div ref={waveformRef} className={styles.waveform} aria-hidden />
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.playBtn}
          onClick={togglePlay}
          disabled={!ready}
          aria-label={playing ? 'Pause recording' : 'Play recording'}
        >
          {playing ? 'Pause' : ready ? 'Play' : '…'}
        </button>
        <span className={styles.time}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <span className={styles.spacer} />
        {assets && (
          <button type="button" onClick={() => void handleDownload()} className={styles.dlLink}>
            Download .opus
          </button>
        )}
        {assets && (
          <Spectrogram
            recordingId={recordingId}
            webCanonicalKey={webCanonicalKey}
            currentTime={currentTime}
            duration={duration}
            onSeek={seek}
          />
        )}
      </div>
      <TranscriptPane
        words={assets?.words ?? []}
        activeIdx={activeWordIdx}
        onJump={seek}
        fallbackText={transcript ?? ''}
      />
    </div>
  );
}

interface TranscriptPaneProps {
  words: WordTimestamp[];
  activeIdx: number;
  onJump: (time: number) => void;
  fallbackText: string;
}

function TranscriptPane({ words, activeIdx, onJump, fallbackText }: TranscriptPaneProps) {
  if (words.length > 0) {
    return (
      <div className={styles.transcript} aria-label="Synchronised transcript">
        {words.map((w, i) => (
          <button
            type="button"
            // Index-based key — start times can collide on malformed
            // pipelines without breaking the render.
            key={`word-${i}`}
            className={`${styles.word} ${styles.wordHover} ${
              i === activeIdx ? styles.wordActive : ''
            }`}
            onClick={() => onJump(w.start)}
            aria-current={i === activeIdx ? 'true' : undefined}
          >
            {w.word + ' '}
          </button>
        ))}
      </div>
    );
  }
  if (fallbackText) {
    return (
      <div className={styles.transcript} aria-label="Transcript (unsynchronised)">
        {fallbackText}
      </div>
    );
  }
  return null;
}

async function fetchPeaks(key: string): Promise<PeaksData | null> {
  const url = await getRecordingAssetUrl(key);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`peaks: ${res.status}`);
  return parsePeaks(await res.json());
}

async function fetchWordTimestamps(key: string): Promise<WordTimestamp[]> {
  const url = await getRecordingAssetUrl(key);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`words: ${res.status}`);
  return parseWordTimestamps(await res.json());
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
