# Musike performance release

This ZIP contains the complete Musike source with the performance changes applied, the compiled Node server at `server/dist/server.mjs`, and the compiled PWA at `web/dist/`. Extract into a fresh directory. Open the `musike-main` folder. The ZIP is a complete release.

## Run the built release locally

Use Node 22. The checks in this release ran on Node 22.23.5. From `musike-main`, start a local test instance.

```bash
HOST=127.0.0.1 PORT=4180 node server/dist/server.mjs
```

Open `http://127.0.0.1:4180`. The standalone bundle serves the included web files. The existing media tools and operator configuration still apply for real playback and integrations.

## Upgrade an existing installation

1. Back up the current server and web build, application data, and instance secret. Keep those together for rollback.
2. Stage the two compiled outputs as a pair using the current environment and data locations. Start against an isolated copy of the data first. Docker users can build the extracted source with the existing Dockerfile and configuration.
3. For auth-enabled deployments, verify the `query-performance-v1` migration marker and the SQLite backup beside the database. Restart staging to verify the migration applies once. Auth-off deployments continue to use the shared JSON library.
4. Refresh the staging PWA and follow `ACCEPTANCE-CHECKLIST.md`. Verify later-page playlist playback starts the selected track in the full queue, and exercise Favorites, offline download and reopen, backup export and restore, shared playlists, and imports.
5. Promote the server and PWA as a pair. Roll back by restoring the previous matched build pair. The previous server can read the database with the added indexes.

## Source rebuild

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm --filter @musike/server bundle
```

The release audit and exact code excerpts are in `PERFORMANCE_RELEASE_AUDIT.md`. The test results and remaining staging checks are in `TEST-RESULTS.md` and `ACCEPTANCE-CHECKLIST.md`. See `PERFORMANCE-RELEASE-SHA256.json` to verify the extracted files.
