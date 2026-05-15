# Autonomous Sentinel

[![CI](https://github.com/Sniper7Kills-LLC/autonomous-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/Sniper7Kills-LLC/autonomous-sentinel/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node 22 LTS](https://img.shields.io/badge/node-22_LTS-339933?logo=node.js&logoColor=white)](./.nvmrc)
[![Codename](https://img.shields.io/badge/codename-Autonomous_Sentinel-7057ff)](./CLAUDE.md)

> **Codename for [eam.watch](https://eam.watch) v4.0** — a serverless rewrite of the EAM Watch platform on AWS Amplify, built around automated SDR ingest, Whisper transcription, and community-validated message entries.
>
> A Sniper7Kills LLC project. Public read access stays free.

---

## Status

**Scaffolded — no backend deployed yet.** The legacy Laravel/Vue 2 app continues to run at [eam.watch](https://eam.watch); its source remains at <https://github.com/sniper7kills/EamWatch> for reference.

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture brief and the QUESTIONS-V*.txt files for the decision history.

---

## What it does

Autonomous Sentinel collects, transcribes, and catalogs Emergency Action Message (EAM) shortwave radio broadcasts. The flow is end-to-end automated:

1. A contributor's Software-Defined Radio (SDR) records broadcasts to a local folder.
2. The Sentinel **Upload Client** (Electron tray app) watches that folder and uploads new recordings to S3 with metadata (frequency, SDR location, timestamp).
3. A **Pre-process Lambda** trims silence, denoises, and produces a web-canonical Opus file.
4. A **Transcribe Lambda** (pluggable: Whisper / OpenAI / Amazon Transcribe / Bedrock) turns audio into text.
5. A **Linguistic Logic Lambda** (rules + AI fallback) standardizes the transcript and extracts structured fields.
6. A **Message entry** is auto-created and surfaced for community validation.
7. Validated entries appear on the public site.

Goal: **30 minutes from broadcast end to published entry.**

---

## Repository layout

```
autonomous-sentinel/                npm-workspaces monorepo root
├── package.json                    workspaces declaration + root scripts
├── tsconfig.base.json
├── .nvmrc                          22
├── LICENSE                         Apache 2.0
├── CLAUDE.md                       working brief for architecture + conventions
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── QUESTIONS*.txt                  decision history (5 rounds, all answered)
├── .github/workflows/              CI
├── web/                            Next.js + React PWA
├── amplify/                        Amplify Gen 2 backend
└── upload-client/                  Electron tray client
```

---

## Setup

### Prerequisites
- Node.js 22 LTS — `nvm use` reads `.nvmrc`
- npm 10+ (ships with Node 22)
- AWS account + credentials profile (for backend work)

### Install
```bash
git clone https://github.com/Sniper7Kills-LLC/autonomous-sentinel.git
cd autonomous-sentinel
nvm use
npm install
```

### Run
```bash
npm run amplify:sandbox    # spin up your personal Amplify backend
npm run web:dev            # Next.js dev server
npm run client:dev         # Electron client dev mode
```

### Lint / typecheck / test
```bash
npm run lint
npm run typecheck
npm run test
```

---

## References

- Legacy source: <https://github.com/sniper7kills/EamWatch>
- AWS Amplify Gen 2: <https://docs.amplify.aws/>
- OpenAI Whisper: <https://openai.com/research/whisper>
- Cognito device-grant flow reference: <https://github.com/aws-samples/cognito-device-grant-flow>

---

## License

**Apache 2.0** for the source code. Recordings published under **CC** (publicly broadcasted material; no party owns the audio).

## Project home

`Sniper7Kills-LLC/autonomous-sentinel` on GitHub.
