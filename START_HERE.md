# Musike 25 November 2026 release

This source repository targets Node 22 and pnpm 10.14.0. The separately packaged release contains the source, compiled server and PWA, and the Git bundle for Hermes. See [the Hermes handoff](HERMES_DEPLOYMENT_HANDOFF_20261125.md) for verification, push, demo acceptance and rollback.

## Build from source

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm --filter @musike/server bundle
```

## Run the paired build

From the extracted `musike-main` directory, point the server at isolated data and cache directories. For example:

```sh
HOST=127.0.0.1 PORT=4180 MUSIKE_DATA_DIR=/tmp/musike-demo-data \
MUSIKE_CACHE_DIR=/tmp/musike-demo-cache MUSIKE_WEB_DIST="$PWD/web/dist" node server/dist/server.mjs
```

Open [the local Musike app](http://127.0.0.1:4180). The existing media tools and operator settings apply for real playback. The release includes source and build hashes in the package manifest. Existing archives and manifests refer to their original release builds.
