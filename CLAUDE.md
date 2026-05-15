# Autonomous Sentinel — Claude Working Notes

> Codename for the v4.0 rewrite of [eam.watch](https://eam.watch). This file is the durable brief for any Claude session working on this repo. Read it first.

## What this project is

**Autonomous Sentinel** (EAM Watch v4.0) is a complete rewrite of the existing Laravel/Vue 2 EAM Watch application as a serverless AWS Amplify stack. The mission is unchanged: collect, transcribe, and catalog Emergency Action Message (EAM) shortwave radio broadcasts and present them publicly with attribution.

Open-source project, sponsored / maintained / operated by Sniper7Kills LLC. Public read access stays free. Paid tier (post-v1) gates *bandwidth-heavy / historical access*, never data ownership.

## Why we are rewriting

The legacy app (`existing/` in this directory) requires manual transcription. The new flow inverts it:

> **SDR captures audio → upload client ships it → backend transcribes → "Linguistic Logic" parses it → community validates.**

Top-line goals:

1. Eliminate manual message entry.
2. Make a recording mandatory for every entry.
3. Hit a **30-minute SLA** from broadcast end → published entry.

## Architecture

### Stack (decided)

| Layer | Choice |
|---|---|
| Frontend | Next.js + React (Amplify default) |
| Backend | AWS Amplify **Gen 2** (TypeScript, `defineBackend()`) |
| Runtime | Node 22 LTS + TypeScript 5.x + **npm workspaces** |
| License | Apache 2.0 |
| GitHub | `Sniper7Kills-LLC/autonomous-sentinel` |
| AWS region | `us-east-1` |
| DNS | Route53 (existing zone for `eam.watch`) |
| Auth | Cognito User Pool, federated to **Google + Discord** (Discord via OIDC bridge — adopt OSS `cognito-discord-oidc-bridge` after code review; fall back to in-house Lambda if issues) |
| Email verification | **Required** at signup |
| Data | DynamoDB via Amplify Data (AppSync GraphQL) |
| Storage | S3 (recordings, exports) + CloudFront edge cache; S3 versioning with 30-day delete-marker retention |
| Functions | Lambda (Node.js 20 default; Whisper container Lambda — tolerate cold start, no provisioned concurrency) |
| Hosting | Amplify Hosting + GitHub Actions for tests/lint pre-merge |
| Email | AWS SES with custom-branded templates |
| Analytics | Umami (start), upgrade path to Matomo |
| Errors | Sentry + GlitchTip; CloudWatch only when needed (cost-aware) |
| Mobile | PWA (installable) |
| Map | **MapLibre + OpenStreetMap tiles** (free + open source only) |
| WAF/DDoS | **AWS WAF** in front of CloudFront (country + IP CIDR blocks via Q133) |
| Theme | Light/dark/auto, military / command aesthetic |
| Accessibility | Target WCAG 2.1 AA |
| Budgets | AWS Budget alarms: $50/mo soft email, $100/mo loud email + admin banner, $200/mo throttle Whisper concurrency + page admin (thresholds configurable in admin UI later) |

### Repos

**Single monorepo** at `Sniper7Kills-LLC/autonomous-sentinel`. Three npm workspace packages:

- **`web/`** — Next.js + React PWA, Amplify Hosting deploys.
- **`amplify/`** — Amplify Gen 2 backend (auth, data, storage, functions). Generates `amplify_outputs.json` consumed by both `web/` and `upload-client/`.
- **`upload-client/`** — Electron tray app. Imports `amplify_outputs.json` directly from `../amplify/` so it talks to the same Cognito + AppSync as the web app.

Different release cadences are handled in CI by path-filtered workflows + tag prefixes (`web-v*`, `client-v*`, `amplify-v*`). Web/amplify deploy continuously from `main`; client builds on tag.

The legacy Laravel app remains on GitHub at `sniper7kills/EamWatch` for reference; its working clone has been removed from this directory now that scaffolding has begun.

### Pipeline components

```
SDR (user-owned)
        │
        ▼
Upload Client (Electron, OAuth device-code, watches folder, multipart resumable upload)
        │
        ▼
S3 (audio bucket, original archived)
        │  object-create event
        ▼
Pre-process Lambda  ── separate, observable
  - silence trim, voice activity detection, noise reduction
  - transcode to single canonical format (TBD — single derivative only, no multi-copy storage; must satisfy all 4 backends + browser playback)
        │
        ▼
Transcribe Lambda  ── pluggable backend, env-wide admin default + per-recording override (admin can re-run a single recording on a different backend for comparison):
  (a) Self-hosted OpenAI Whisper (container Lambda, default model: medium 769M)
  (b) OpenAI hosted Whisper API
  (c) Amazon Transcribe (custom-vocab w/ callsigns)
  (d) Bedrock multimodal (audio-in models)
  - chunks long audio into ~5 min segments, transcribes each, stitches result
    (chunking also supports later "more to follow standby" splitting)
  - language hint = en; reject non-English but still attempt
  - word-level timestamps for scrub-to-text sync
        │
        ▼
Linguistic Logic Lambda  ── hybrid: rules + regex first; AI fallback only when rules don't match
  - AI provider stays in AWS (Bedrock); admin-selectable model in admin UI
  - Each recording tracks `linguistic_attempts: [{provider, prompt_version, prompt_hash, result_hash, ts}]`
  - Same (provider + prompt_version) never re-runs on the same input
  - Bumping prompt_version re-processes ONLY previously-failed recordings (not successful ones)
  - Confidence threshold: 0.8 default, admin-tunable per message type
        │
        ▼
DynamoDB → Message
  - confidence ≥ 0.8 → auto-published clean
  - confidence < 0.8 → auto-published, flagged for community review
  - failed transcription → recording stored with `transcription_failed=true`, no Message
        │
        ▼
Community validation
  - Votes append revisions; majority = truth; full audit log of every change
  - Any user can submit a manual transcript on a failed recording
        │
        ▼
Live updates pushed via AppSync subscription to all connected clients
```

### Storage / retention / access gating

- Average recording: ~2 MB / ~3 min. Long auto-recordings can hit hours; multipart resumable upload required; aim < 1 GB but allow longer.
- **Two persistent files per recording:**
  1. **Original** — exactly what the user uploaded (WAV, MP3, whatever). Kept untouched in S3 for archival.
  2. **Web canonical** — **Opus 32 kbps mono** (`.opus` in OGG container) used for browser playback. Voice-optimized; ~250 KB per 60s. Generated by pre-process Lambda.
- **Pipeline temp files** — pre-process Lambda may write transient working files to a `pipeline-temp/` S3 prefix during transcription. **Deleted on publish.** Lifecycle policy expires anything in `pipeline-temp/` older than 7 days regardless (catches failed-publish leaks).
- Recordings go to S3 Standard. **No cross-region replication.** Backups: DynamoDB PITR + S3 versioning (30-day delete-marker retention on the recordings prefix per Q138).
- **Free tier:** browse + listen last **90 days** of recordings. Transcripts + metadata: **full history free**.
- **Paid tier:** historical browse + listen beyond 90 days, bulk recording download (zip), advanced features (per Q98).
- **Audit log: retained forever.**
- Recording license: **CC** (publicly broadcasted; no one owns the audio).
- Recording playback: signed URLs from CloudFront. Hard rate-limit per IP, admin-tunable in admin UI. Admin sees stats: most-played audio, top-playing users.

### Recording deletion

- Admin deletes a Recording → cascade-deletes the Message (legacy-style: messages with no recording cease to exist).
- Recording row: **soft-delete** in DynamoDB (audit trail).
- Recording file in S3: **hard-delete**, with **S3 versioning + 30-day delete-marker retention** so admins can restore within the recovery window.

### Message deletion

- Admin only. **Soft-delete** with audit log entry. Hidden from public view. Admins can toggle a filter to see + restore deleted messages.

## Domain model (target)

> Source: legacy `existing/app/Models/`. Names kept recognizable so legacy users map.

- **Message** — broadcast event. UUID PK. Fields: `broadcast_ts` (UTC), `sender`, `receiver`, `type`, parsed body, character/codeword counts, confidence score, `legacy_uuid` (nullable), soft-delete flag, audit chain.
- **Message type** — keep legacy enum: `BACKEND`, `SKYKING`, `ALLSTATIONS`, `RADIOCHECK`, `SKYMASTER`, `SKYBIRD`, `DISREGARDED`, `OTHER`. New types may be added; don't silently rename.
- **Recording** — audio file. UUID PK. **One Message → many Recordings** (multiple SDRs catch the same broadcast). Hash-deduplicated: identical content_hash rejected on upload (logged for review as possible malicious actor). Has `frequency_khz` (int), `modulation` (USB/LSB/AM/FM enum), `broadcasted_at`, `automated`, `sdr_id`, `transcription_failed` flag, soft-delete flag.
- **Revision** — append-only change log on Messages and Transcripts. Tracks actor + diff + timestamp. Visible to users.
- **AuditLog** — every admin/mod action with diff. Visible where appropriate. Retained forever.
- **SDR** — registered radio. Owned by a User. Has `name`, `location` (lat/lon, user-chosen via map selector with user-selectable granularity), `transmitter_id` (optional, admin-assigned).
- **Transmitter** — admin-managed, **publicly visible** on propagation map. Pre-populated at launch by researching public sources (HFGCS Wikipedia, reference sites) and seeding initial JSON for owner review before commit.
- **SDR public visibility** — per-SDR owner toggle: public (shown on propagation map at owner's chosen granularity) vs admins-only.
- **User** — Cognito-backed account. Roles: `admin`, `moderator`, `member`. Public profile page per user with submission stats. Profile fields blankable on self-deletion (account + data + audit retained). Reputation score tracks validated submissions (drives vote weight).
- **Vote** — community validation primitive. Two surfaces:
  - **Per-field on the parsed Message** (sender / receiver / body / type each have their own vote tally).
  - **Per proposed transcript revision** on the raw transcript text (user submits a corrected transcript, others upvote/downvote that whole revision, majority wins).
  **Reputation-weighted** with the following default formula (every number admin-tunable in admin UI):
  - Base weight: 1
  - +0.1 per validated submission (recording uploaded that produced a successful Message), capped at +4
  - +0.5 per accepted correction (a user's revision adopted by majority), capped at +5
  - +1 if role = moderator
  - +2 if role = admin
  - Net cap: 5x weight
  **Public visibility: aggregate counts only** ("12 say B, 3 say D"); individual votes hidden from public, visible to mods + admins only.
- **SDR ownership on user self-deletion** — same as the user account: kept with PII blanked. SDR retains owner FK and history; recordings unaffected.
- **Guest** — **DROPPED**. No anonymous submissions in v4.
- **Comment** — nested replies up to **3 levels** (top + 2 reply tiers); deeper replies flatten into the deepest level. Auto-flagged by the moderation pipeline.
- **Frequency / Modulation** — defined enum (curated EAM frequencies). Selectable in UI.
- **Callsign dictionary** — DDB table of known sender/receiver callsigns. Quick-select in UI; free-form entry still allowed.
  - **Migration seed:** bootstrap from legacy DB (`SELECT DISTINCT sender, receiver FROM messages`), then run an AI-assisted cleanup pass via Bedrock to dedupe spelling variants ("SKYKING" / "Sky King" / "SKY KING"). Auto-merge above confidence threshold; queue lower-confidence merges for admin review.
  - **Ongoing:** every new freeform callsign entry is checked against the dictionary at write time; AI suggests merge above threshold (deferred behind a feature flag if needed at v1).
- **AbuseReport** — user-flagged spam/bad entries for mod queue.
- **DiscordWebhook (RelayProvider)** — kept (Twitter dropped). Per-user; outbound new-message notifications. Possibly premium-tier.
- **Donation / Supporter** — Stripe-backed. One-time + multiple recurring monthly tiers. Time-delayed supporter badge (badge duration scales with donation amount; formula TBD).

### Time
**UTC always in DB.** UI offers user toggle to display in local time.

## Notifications

User chooses any combination:
- **Email** (SES, custom templates).
- **Web Push** (browser native, service worker). Audio alert = **canned tones per message type** (no recording autoplay).
- **Discord Webhook** (per-user). Embed with link to entry + audio file attached to Discord. **Fallback: link-only with "audio too large to attach" note when audio exceeds Discord upload limit.** Possibly premium-tier.

Subscription granularity at v1: **per message type**. Per-callsign / per-frequency / per-SDR added later.

## Donations / Paid Tier

Stripe-backed. Two paths:

- **One-time donation** — flat amount picker. Optional supporter badge granted with duration scaling by amount (formula TBD — log-flavored, see Q148).
- **Recurring monthly subscription** — initial tier shape (tweakable later):
  - **Tier 1 — $3/mo** — supporter badge, historical access to 180 days
  - **Tier 2 — $7/mo** — Tier 1 + bulk download (capped), advanced filters
  - **Tier 3 — $15/mo** — Tier 2 + Discord webhook relays, REST API rate-limit bump, full historical access
- **Stripe fees** — project eats fee by default; Stripe Checkout shows opt-in "cover the fee" toggle for the donor.
- Recurring subscribers' badges auto-renew while subscription is active; expire N days after final payment.

Stripe wiring deferred until first paid feature actually ships. Current TBD slot.

## Search

Full-text over transcripts. **Start with DynamoDB** best-effort. Plan to migrate to OpenSearch / Postgres FTS when corpus or query patterns demand it.

## API surface

- **GraphQL** via AppSync — primary; **anon-readable** for public browse (the website itself uses this). Ideally invisible to outside consumers vs the published REST API; risk accepted in exchange for guest browse.
- **REST API: built at v1, authenticated only.** Read-only at v1, scoped to: messages, recordings, transcripts. (SDRs, transmitters, users, votes, comments stay GraphQL-only.) Upload client uses GraphQL via Amplify natively. API keys for researchers (signed up via dev portal) + Cognito JWT for user-context calls. Per-key rate limits.
- **Hard-versioned** (`/v1/`, `/v2/`).

## Audio player features

Full kit: HTML5 controls, **waveform visualization**, **spectrogram**, **MP3 download**, **scrub-to-text sync** (word-level timestamps drive text highlight). Inline correction form so users can fix transcript while audio plays.

## HF propagation context

For each registered SDR location, pull live NOAA solar flux index / K-index data and overlay on a propagation map alongside broadcast time. Admin-managed transmitter list (publicly visible, pre-populated with known EAM sites) helps attribute which transmitter an SDR likely captured. MapLibre + OSM only.

## Migration from v3

- **Account claim:** email-match auto-link on signup. During migration, accounts pre-created and emailed to users with claim instructions. All v3 users have verified emails.
- **Admins/mods:** preserved as-is.
- **Data:** all Messages/Recordings transferred. **Preserve legacy UUIDs** where possible; fall back to `legacy_uuid` field on collision.
- **URLs:** legacy URLs do **not** redirect — break and rely on search.
- **Cutover:** develop on `beta.eam.watch` subdomain, then DNS swap once stable + migration done.
- **Drop:** Guests, Twitter relay, SupporterMessage feature.

## Pages / UX surfaces

- **Default landing (`/`)** — personalized dashboard if logged in; latest messages feed for guests.
- Public messages list.
- **Skykings** dedicated tracker page.
- **Skybird** dedicated page (same `SKYBIRD` enum, separate filtered view).
- Charts: character-count, codeword-count, daily-count (legacy three) + new ones as reasonable.
- HF propagation map (live NOAA SFI / K-index per SDR location, transmitter overlay).
- Public user profile pages with submission stats.
- **My Uploads** dashboard for contributors — list of every recording they've uploaded with per-step pipeline status badges (queued → preprocessing → transcribing → parsing → published / failed). Visible to owner; cheap via a DynamoDB status field + AppSync subscription.
- Admin UI: DLQ + manual reprocess, transmitter editor, callsign editor (incl. AI-assisted merge tool), Linguistic Logic config, audit log viewer, ban management (country + IP CIDR), banned-region landing-page editor (custom message per country), playback rate-limit tuning + stats (most-played audio, top-playing users), fine-tune trigger, AWS budget threshold tuning.
- **RSS / Atom** feed of new messages.

### Bans + region blocks

- Ban scope: **configurable per ban** (default write-only — visitors from blocked country can still browse public archive). Admin can escalate to read-block per ban.
- Country-blocked visitors land on an **admin-designable banned-region page** (per-country custom content).
- Ban evasion detection at v1: **email + IP only**. Cognito Advanced Security Features ($0.05/MAU) skipped at v1 for cost; browser fingerprint library skipped. Escalate to fingerprint (FingerprintPro) + Cognito ASF if ban evasion becomes a real problem.
- **Banned users blocked at Stripe Checkout** (no donations from banned accounts; ban remains effective regardless of money sent).

### Manual transcription

- **Strictly gated** to `transcription_failed=true` recordings. Anyone can submit a manual transcript on a failed recording (becomes a revision proposal under community vote).
- Comments / corrections on successfully-transcribed recordings: use the existing comment + abuse-flag system, **not** a new transcription submission. Preserves the "no manual entry" rule.
- Manual transcripts pass through the same profanity / hate-speech auto-flag as comments (Q156 — spammers will try to inject bad content here).

### Content moderation

- **Auto-flag both transcripts and comments** for profanity / hate-speech via a **hybrid pipeline**: open-source wordlist (e.g. `obscenity`) runs first as a free fast filter; on a hit, AWS Comprehend confirms before flagging publicly. Cuts cost by avoiding Comprehend calls on the (vast) majority of clean text.
- Flagged content stays visible but is marked for moderator review.
- User-reported abuse goes to the same moderator queue.

## ML feedback loop

Community-corrected transcripts stored as revisions. Custom EAM Whisper fine-tune triggered by **either** (a) accumulating ~1000 validated corrections **or** (b) admin manual button.

## Workflow

**GitHub is the source of truth for all planning, tracking, and progress.** Specifically:

- **All new work originates from a GitHub issue** in `Sniper7Kills-LLC/autonomous-sentinel`. If there is no issue, write one before starting.
- **Do not create new markdown planning / tracking files** unless they are reference docs that belong in the repo for users (READMEs, CONTRIBUTING, decision-log additions, etc.). No `TODO.md`, `ROADMAP.md`, `PLAN.md`, `STATUS.md`, etc.
- **Never duplicate issue content into the repo as markdown.** If you need a checklist, use the issue body.
- Existing markdown files (this `CLAUDE.md`, `README.md`, package READMEs, `docs/decisions/*`) are reference material — keep them current but do not bloat them with status updates.
- Labels in use: `area:web`, `area:amplify`, `area:client`, `area:infra`, `area:docs`; `type:feat`, `type:fix`, `type:chore`, `type:refactor`; `priority:p0/p1/p2`. Phases tracked as milestones (`phase 0 — repo setup` through `phase 10 — cutover`).

## Conventions for Claude

- **Always start from a GitHub issue** (see Workflow above). If asked to do work without an issue reference, ask which issue or open one first.
- **Do not create git worktrees inside `.claude/` or `docs/decisions/`** — those paths hold config and immutable history. Worktrees there confuse settings discovery and pollute history.
- **Do not modify `docs/decisions/round-*.txt`** — append-only history. New decisions update `CLAUDE.md` (here) and live in the issue thread that produced them.
- **Amplify Gen 2 idioms only** — `defineBackend()`, `defineAuth()`, `defineData()`, `defineFunction()`, `defineStorage()`. No Gen 1 CLI artifacts.
- **No new manual-entry flows.** Every Message originates from a Recording. Manual user transcripts only enter via the failed-recording correction path.
- **Recording = source of truth.** Transcript and parsed Message fields are derived. Edits **append revisions**; never overwrite.
- **Configurable Linguistic Logic.** Rules, schemas, thresholds load from DynamoDB at runtime.
- **30-minute SLA is real.** Use async + queue between stages, not chained synchronous calls. Pipeline must support retrieval/retry of stuck recordings.
- **Cost-aware defaults.** Free-tier first; flag any service > $50/mo idle. See `~/.claude/.../memory/feedback_cost.md`.
- **No GDPR scaffolding.** US-focused. See `~/.claude/.../memory/feedback_compliance.md`.
- **Audit everything.** Every edit/delete/ban gets an audit log entry with actor + diff. Retained forever.
- **Caveman / normal:** user has caveman mode on for chat. Code, commits, PRs, docs (this file, README) stay normal prose.

## Repo layout

```
autonomous-sentinel/                ← npm-workspaces monorepo root
├── package.json                    npm workspaces declaration
├── tsconfig.base.json
├── .nvmrc                          22
├── .editorconfig
├── .gitignore
├── LICENSE                         Apache 2.0
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── CLAUDE.md                       this file
├── QUESTIONS*.txt                  decision history (rounds 1–5, all answered)
├── .github/
│   └── workflows/
│       ├── ci.yml                  lint + typecheck + test on PR (path-filtered)
│       └── client-release.yml      Electron build on `client-v*` tag
├── web/                            Next.js + React PWA
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.mjs
│   └── app/
├── amplify/                        Amplify Gen 2 backend
│   ├── package.json
│   ├── tsconfig.json
│   ├── backend.ts                  defineBackend() entry
│   ├── auth/resource.ts
│   ├── data/resource.ts
│   ├── storage/resource.ts
│   └── functions/
│       ├── preprocess/
│       ├── transcribe/
│       └── linguistic/
└── upload-client/                  Electron tray app
    ├── package.json
    ├── tsconfig.json
    ├── electron/                   main process
    └── src/                        renderer process (React)
```

## Open follow-ups

All architectural and product TBDs are now resolved. Remaining items before scaffolding:

- AWS region (likely `us-east-1` for Bedrock + Whisper container availability — confirm).
- DNS provider for `eam.watch` (need access to set up `beta.eam.watch` for cutover plan).
- Confirm pnpm workspace layout (root `package.json` + `web/` and `amplify/` packages).
- Confirm GitHub Actions workflow targets at v1 (lint + typecheck + unit tests; e2e deferred).
