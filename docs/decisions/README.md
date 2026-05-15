# Design Decision Log

Round-by-round Q/A history that produced the architecture in [`../../CLAUDE.md`](../../CLAUDE.md). Preserved for posterity — when a future contributor asks "why DynamoDB and not Aurora?" or "why MapLibre and not Mapbox?", the answer is here.

| Round | File | Topics |
|---|---|---|
| 1 | [round-1.txt](round-1.txt) | Initial 50: stack, Whisper hosting, domain, migration, repo/ops, schema, real-time, upload client, security |
| 2 | [round-2.txt](round-2.txt) | Transcription internals, paid features, retention, live UX, prompt versioning, map, accounts, notifications, orchestration, deletion |
| 3 | [round-3.txt](round-3.txt) | Canonical format, backend switching, Discord integration, donation tiers, WAF, ban scope, data seeding, SDR privacy, S3 undo, REST auth, budgets |
| 4 | [round-4.txt](round-4.txt) | Storage 2-file model, Cognito ASF skipped, REST built at v1, vote shape, comment depth, profanity policy, banned-user donations |
| 5 | [round-5.txt](round-5.txt) | Opus codec, REST scope, vote target, reputation formula, repo placement, license, Node + npm |

These are immutable — once a round is answered, decisions move into `CLAUDE.md`. Don't edit the historical files in place.

New work tracked as **GitHub Issues**, not new markdown files. See `CLAUDE.md` for workflow.
