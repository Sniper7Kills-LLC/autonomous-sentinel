// Fetch the pinned static ffmpeg build for the preprocess Lambda layer (#503).
//
// Downloads a specific, immutable BtbN FFmpeg-Builds release asset,
// verifies its SHA-256, and extracts `bin/ffmpeg` into
// `amplify/layers/ffmpeg/bin/ffmpeg` — the asset dir the CDK
// `LayerVersion` in `amplify/backend.ts` zips into the layer (→
// `/opt/bin/ffmpeg` at runtime).
//
// Runs both locally (before `ampx sandbox` / synth) and in the Amplify
// backend build (see `amplify.yml`) before `ampx pipeline-deploy`. The
// binary is gitignored — it's reproduced from this pinned source, never
// committed.
//
// Pin: BtbN static, LGPL, linux64 (Lambda x86_64), ffmpeg 8.1.1. To
// bump, pick a new immutable `autobuild-YYYY-...` tag + its static
// `linux64-lgpl` asset, download it, recompute the SHA-256, and update
// all three constants below.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TAG = 'autobuild-2026-05-28-14-16';
const ASSET = 'ffmpeg-n8.1.1-9-g58d4114d36-linux64-lgpl-8.1.tar.xz';
const SHA256 = 'a54b56aab8f28c3af8c8c49bc18926faed1adfe32c15675171ac7d506ae92c5a';
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${ASSET}`;

const here = dirname(fileURLToPath(import.meta.url));
const layerDir = join(here, '..', 'layers', 'ffmpeg');
const binDir = join(layerDir, 'bin');
const binPath = join(binDir, 'ffmpeg');

if (existsSync(binPath)) {
  console.log(`fetch-ffmpeg: ${binPath} already present — skipping`);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });
const tarPath = join(layerDir, '.ffmpeg.tar.xz');

console.log(`fetch-ffmpeg: downloading ${URL}`);
execFileSync('curl', ['-fsSL', '-o', tarPath, URL], { stdio: 'inherit' });

const actual = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
if (actual !== SHA256) {
  rmSync(tarPath, { force: true });
  throw new Error(`fetch-ffmpeg: SHA-256 mismatch — expected ${SHA256}, got ${actual}`);
}
console.log('fetch-ffmpeg: SHA-256 verified');

// Archive layout is `<release>/bin/ffmpeg`; strip both segments so the
// binary lands directly at `bin/ffmpeg`.
execFileSync(
  'tar',
  ['-xJf', tarPath, '-C', binDir, '--wildcards', '--strip-components=2', '*/bin/ffmpeg'],
  { stdio: 'inherit' },
);
rmSync(tarPath, { force: true });

if (!existsSync(binPath)) {
  throw new Error('fetch-ffmpeg: ffmpeg binary not found after extraction');
}
execFileSync('chmod', ['+x', binPath]);
console.log(`fetch-ffmpeg: ready ${binPath} (${statSync(binPath).size} bytes)`);
