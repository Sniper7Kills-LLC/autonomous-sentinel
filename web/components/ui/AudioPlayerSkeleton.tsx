'use client';

import { useState } from 'react';
import styles from './AudioPlayerSkeleton.module.css';

interface AudioPlayerSkeletonProps {
  title: string;
  meta: string;
  /** Total duration in seconds (display only — no real audio). */
  duration?: number;
  /** Pseudo-random bars for the waveform. Stable per props. */
  seed?: number;
}

function makeBars(seed: number, count: number): number[] {
  // Deterministic pseudo-random — stable between SSR + CSR so no
  // hydration mismatch. Mulberry32 PRNG.
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    // Bias to mid-tall bars for voice-like look
    out.push(0.25 + r * 0.7);
  }
  return out;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

export function AudioPlayerSkeleton({
  title,
  meta,
  duration = 184,
  seed = 7,
}: AudioPlayerSkeletonProps) {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0.34); // 0..1
  const bars = makeBars(seed, 96);
  const current = duration * pos;

  return (
    <div className={styles.player}>
      <div className={styles.header}>
        <div className={styles.titles}>
          <div className={styles.title}>{title}</div>
          <div className={styles.meta}>{meta}</div>
        </div>
        <button
          type="button"
          className={styles.play}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? '❚❚' : '▶'}
        </button>
      </div>

      <div
        className={styles.wave}
        role="slider"
        aria-label="Audio position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos * 100)}
        tabIndex={0}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
        }}
      >
        {bars.map((h, i) => {
          const played = i / bars.length < pos;
          return (
            <span
              key={i}
              className={`${styles.bar} ${played ? styles.played : ''}`}
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          );
        })}
        <span className={styles.cursor} style={{ left: `${pos * 100}%` }} aria-hidden />
      </div>

      <div className={styles.footer}>
        <span className={styles.time}>{fmt(current)}</span>
        <span className={styles.divider}>/</span>
        <span className={styles.timeTotal}>{fmt(duration)}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.controlBtn}>
          Download MP3
        </button>
      </div>
    </div>
  );
}
