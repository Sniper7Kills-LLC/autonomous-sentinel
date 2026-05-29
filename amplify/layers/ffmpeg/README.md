# ffmpeg Lambda layer (#503)

Provides a static `ffmpeg` binary at `/opt/bin/ffmpeg` for the preprocess
Lambda's Opus 32 kbps mono transcode.

- `bin/ffmpeg` is **not committed** (it's ~174 MB). It is fetched and
  SHA-256-verified from a pinned, immutable BtbN FFmpeg-Builds release by
  [`../../scripts/fetch-ffmpeg.mjs`](../../scripts/fetch-ffmpeg.mjs),
  which runs before `ampx` synth — locally and in the Amplify backend
  build (`amplify.yml`).
- Pin: ffmpeg **8.1.1**, static, LGPL, `linux64` (Lambda x86_64). To bump,
  update the `TAG` / `ASSET` / `SHA256` constants in the fetch script.
- The CDK `LayerVersion` in `amplify/backend.ts` zips this directory; the
  `bin/` contents map to `/opt/bin/` at runtime.

The handler only invokes ffmpeg when `FFMPEG_PATH=/opt/bin/ffmpeg` is set
on the function; until that env is wired it keeps the byte-copy fallback.
