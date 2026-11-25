# Musike release handoff for Hermes

- **Release branch** `release/musike-20261125`
- **GitHub fork** [Azan-Shah/musike](https://github.com/Azan-Shah/musike)
- **Required base** `61b090aa419960af5b3c7af53196195cb7a2eddd`
- **Build target** Node 22.23.5 with pnpm 10.14.0

The release ZIP contains the exact source tree, compiled server/PWA, a Git bundle, and `RELEASE-SHA256.json`. The manifest lists the release commit and individual file hashes. Use Hermes’s existing GitHub credentials through its configured Git transport. Keep credentials and operator configuration out of command output and release files.

## 1. Verify and push the release branch

Extract into a clean directory, set `release_dir` to its absolute path, and verify the manifest.

```sh
python3 - "$release_dir" <<'PYTHON'
from hashlib import sha256
from pathlib import Path
import json
import sys

root = Path(sys.argv[1])
manifest = json.loads((root / "RELEASE-SHA256.json").read_text())
for name, info in manifest["files"].items():
    body = (root / name).read_bytes()
    if len(body) != info["bytes"] or sha256(body).hexdigest() != info["sha256"]:
        raise SystemExit(f"Release file failed verification: {name}")
print("Verified release files for", manifest["commit"])
PYTHON
```

Use a staging Git checkout of the fork with a working `origin` pointing to `https://github.com/Azan-Shah/musike.git` or its SSH equivalent. The commands below assume that `release_dir` holds the extracted package and the current directory is that Git checkout.

```sh
git remote get-url origin
git fetch origin main
git bundle verify "$release_dir/Musike_Release_20261125.bundle"
git fetch "$release_dir/Musike_Release_20261125.bundle" refs/heads/release/musike-20261125
release_commit=$(git rev-parse FETCH_HEAD)
git show --stat --oneline "$release_commit"
git merge-base --is-ancestor 61b090aa419960af5b3c7af53196195cb7a2eddd "$release_commit"
```

Compare `release_commit` with `commit` in `RELEASE-SHA256.json` before pushing. If the release branch already exists on GitHub, compare its SHA and report any discrepancy. A normal non-forced push publishes the branch.

```sh
git push origin "$release_commit:refs/heads/release/musike-20261125"
git ls-remote origin refs/heads/release/musike-20261125
```

The branch push creates no production image by itself. The repository’s Docker workflow runs for version tags and manual dispatch. Use the usual Hermes demo image process, pin the verified commit and record the image digest. If dispatching the workflow, select the release branch explicitly and use the resulting SHA image for demo. Leave the existing production tag untouched until the promotion gate.

## 2. Stage the matched build

Use the existing demo configuration and a consistent copy of the auth database plus instance secret. For auth-off staging, use a copy of the shared JSON library. Retain the previous production server/PWA image and digest, the existing environment, Compose configuration, tool wrapper, cache, and PWA storage. The Dockerfile already supplies FFmpeg.

To verify/rebuild from the checked out release on Node 22.23.5:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm --filter @musike/server bundle
```

Start the compiled server and PWA together. Verify the origin and public health route, HTML, fingerprinted worklet, manifest and service worker. Refresh clients to use matched assets. Auth-on startup applies `audio-normalization-off-v1`. Verify the mode-0600 pre-migration backup, retained values and revisions, and the marker. Restart once and confirm the migration skips. Check the new Off preference through the signed-in Settings UI with two devices. Existing downloads remain in IndexedDB v2.

```sql
SELECT key, value FROM migrations WHERE key = 'audio-normalization-off-v1';
PRAGMA foreign_key_check;
```

Capture representative timings on the same demo dataset before and after. Include `/api/library/summary`, `/api/social/presence`, `/api/social/shares`, first byte of media, and device seeks. Report sample sizes and p50/p95. Preserve user-facing IDs and redact private account data from shared logs.

## 3. Verify the audio and data fixes

- Set the hardware and software volume once. Compare Quiet, Standard, Loud and Off on a warm measured track, a cold track, a downloaded track, and a video. Try quiet-to-loud-to-quiet passages and ten locked Android auto-advances in a normal playlist over mobile data. Include rapid Next/Previous, mute, repeat, a video switch, external audio interruption, and Bluetooth if available. Seek and device/jam transfer must retain the assigned output and avoid abrupt volume changes.
- A measured complete cached audio fetch may include `x-musike-loudness: 1,<LUFS>,<dBTP>`. The playback tab binds it to that complete body. Range requests, cold native media starts, legacy downloads without a measurement, and video use a fixed fallback. Analysis can be absent on the first warm request while the server computes it. It never changes an already playing track.
- Spot-check Library edits, version 1 restore and merge with a large fixture, Favorites and later-page playback, social permission/revocation, downloads/pins, and explicit output takeover after the old device is stale. Use a sandbox account for YouTube history with its existing link and confirm a play of at least 10 seconds reaches history. Playback and UI fixtures used synthetic assets and mock external providers.
- Compare capture levels around the opening and track changes. An unexpected burst, loss of audio on transfer or unlock, a new SQLite integrity error, or lost downloads blocks normal production promotion. Record device, output, source type, timestamp and opt-in diagnostic trace where available.

## 4. Promote and roll back under the existing production procedure

Once staging passes and the deployment is approved through the existing process, promote the pinned server/PWA image together. Verify running image digest, health and public URL, availability of the worklet, SQLite migration status and live playback. Preserve the existing single-process ownership of the data directory.

If rollback is required, restore the previously verified matched image and assets first. The old application can read the migrated table, and its browser maps Off to Standard. Preserve the SQLite DB, instance secret, cache and IndexedDB if the issue is limited to code/assets. Restore a consistent data backup only when needed and account for writes made since it was created. Report the branch SHA, image digest, smoke checks, physical acceptance and any remaining issue to Azan.
