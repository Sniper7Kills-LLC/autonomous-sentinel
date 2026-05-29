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
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TAG = 'autobuild-2026-05-28-14-16';
const ASSET = 'ffmpeg-n8.1.1-9-g58d4114d36-linux64-lgpl-8.1.tar.xz';
const SHA256 = 'a54b56aab8f28c3af8c8c49bc18926faed1adfe32c15675171ac7d506ae92c5a';
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${ASSET}`;
// Static ffmpeg is well over 100 MB; a much smaller file means a bad
// extraction. Sanity floor to reject a truncated/partial binary.
const MIN_BINARY_BYTES = 50_000_000;

const here = dirname(fileURLToPath(import.meta.url));
const layerDir = join(here, '..', 'layers', 'ffmpeg');
const binDir = join(layerDir, 'bin');
const binPath = join(binDir, 'ffmpeg');
const tarPath = join(layerDir, '.ffmpeg.tar.xz');

function sha256Stream(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(path);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  // Skip only when a fully-valid binary is already present (a complete
  // extraction is atomic — see the size check + cleanup below — so an
  // existing binPath of the expected size is trustworthy).
  if (existsSync(binPath) && (await stat(binPath)).size >= MIN_BINARY_BYTES) {
    console.log(`fetch-ffmpeg: ${binPath} already present + sized — skipping`);
    return;
  }
  await rm(binPath, { force: true });
  await mkdir(binDir, { recursive: true });

  try {
    console.log(`fetch-ffmpeg: downloading ${URL}`);
    execFileSync('curl', ['-fsSL', '-o', tarPath, URL], { stdio: 'inherit' });

    const actual = await sha256Stream(tarPath);
    if (actual !== SHA256) {
      throw new Error(`fetch-ffmpeg: SHA-256 mismatch — expected ${SHA256}, got ${actual}`);
    }
    console.log('fetch-ffmpeg: SHA-256 verified');

    // Archive layout is `<release>/bin/ffmpeg`; strip both segments so
    // the binary lands directly at `bin/ffmpeg`.
    execFileSync(
      'tar',
      ['-xJf', tarPath, '-C', binDir, '--wildcards', '--strip-components=2', '*/bin/ffmpeg'],
      { stdio: 'inherit' },
    );

    if (!existsSync(binPath) || (await stat(binPath)).size < MIN_BINARY_BYTES) {
      throw new Error('fetch-ffmpeg: extracted ffmpeg missing or too small');
    }
    execFileSync('chmod', ['+x', binPath]);
    console.log(`fetch-ffmpeg: ready ${binPath} (${(await stat(binPath)).size} bytes)`);
  } catch (err) {
    // Never leave a partial/corrupt binary behind — the next run must
    // re-fetch rather than skip on a broken file.
    await rm(binPath, { force: true });
    throw err;
  } finally {
    await rm(tarPath, { force: true });
  }
}

await main();
