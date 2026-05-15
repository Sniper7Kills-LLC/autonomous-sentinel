# `@autonomous-sentinel/upload-client`

Electron tray app for [Autonomous Sentinel](../README.md). Watches a user-configured folder for SDR recordings, authenticates via OAuth 2.0 device-code flow, and uploads to the Sentinel backend.

## Develop

```bash
npm run client:dev      # from monorepo root
# or
npm run dev             # from this directory
```

Imports `amplify_outputs.json` from `../amplify/`. Run `npm run amplify:sandbox` first if you don't have one.

## Build (unsigned)

```bash
npm run package
```

Code signing (Apple notarization, Windows Authenticode) is intentionally deferred per `CLAUDE.md` — builds are unsigned at v1, users are warned.
