# Musike — all-issues review and playback repair

20 November 2026. Approved after the user's scope answers and final confirmation. Baseline: `musike-main (7).zip`, SHA-256 `625ca84bc7115064a867eac89da4d59a76d47bcb92077a2abcc54dcbff8e4d96`.

## Result and limits

BUG-025's permanent lookahead lockout and the newly documented BUG-026 repeat-one jam timeline defect are resolved in source. Android transition and offline-body defects have source repairs with regression coverage. The original 138 tests and final 149 tests pass; server/web typechecks, production web/PWA and server bundles pass. One web/PWA product remains.

Samsung A07/A15 locked-screen reliability is still a physical acceptance item. The user reports personal playback fails on both phones, on Wi-Fi/mobile data and speakers/Bluetooth, with the notification disappearing and playback resuming on unlock. Manual locked Next and jam background playback have not yet been tested. No new diagnostics were supplied. Automated fixtures are not proof that those live symptoms are resolved, and no deployment occurred.

## Impact analysis — exact application files

| File | Functions / changes |
| --- | --- |
| `server/src/audioCache.ts` | `AudioCache.update`: budget/transient failures share finite 30-second retry deadline; cancellation, revisions and active-file protection retained |
| `server/src/jams.ts` | `position`: playing repeat-one modulo duration; `observe`: circular drift, prompt host discontinuities/duration changes, repeat/preferences changes and pending-command recheck under the room lock |
| `web/src/lib/jams.ts` | `receive`: modulo repeat-one projection; reject older same-version progress responses |
| `web/src/lib/playbackSync.ts` | `startPlaybackSync` subscription promptly publishes backward position changes; `alignJam` uses circular drift and restores missed same-track playing intent |
| `web/src/player/player.ts` | `load`/repeat subscription enable native looping; `warmQueue` prepares complete next audio before server readiness and hydrates offline next audio early; `onEnded` retains safe fallback restart state; `wire` rejects stale pause notifications; `resumeOutput` preserves same-song media and applies minimal seek/play/pause with output/session guards |
| `web/src/lib/playbackPreload.ts` | `retain`/`hydrate` generation fencing; `prepare` bounded retry/backoff, optional-storage fallback, unauthorized signal, response cancellation and full declared-body checks |
| `web/src/lib/offlineDownloads.ts` | `fetchCompleteAudio` rejects declared-length truncation before persistent admission |
| `deploy/ytdlp-wrap.sh` | Executable permission restored to 0755 because the uploaded archive omitted it. File contents unchanged |

All SQL remains parameterized, scoped to authenticated membership/hosting and asynchronous through the existing SQLite worker. No SQL schema/index, endpoint, DOM hook, runtime dependency, CSS token, component rendering or operator configuration changed. `ARCHITECTURE.md` is unchanged as requested. No native target, silent audio or service-worker music scheduler was introduced.

## Code changes and regression evidence

The complete source ZIP contains full replacements, without placeholders. The clean Git patch contains every changed/new source, test and documentation file plus the wrapper mode correction. Apply either delivery method, once, to the exact baseline.

Eleven added tests:

- `server/test/audio-cache.test.ts`: leased budget full, no immediate thrash, release space, advance backoff and recover the identical queue.
- `server/test/collaboration.test.ts`: repeat-one across multiple cycles, guest output projection, immediate real host restart and rejection of guest authority.
- `server/test/jam-timeline-client.test.ts`: actual browser polling code, repeat-one modulo, older same-version progress rejection and unwrapped paused endpoint position.
- `server/test/player-lifecycle.test.ts`: five new actual-player fixtures for queued pause, offline prehydration, native repeat, early complete-body handoff and same-song jam source retention.
- `server/test/playback-preload.test.ts`: three new fixtures for bounded retry recovery, truncation/optional-storage failure and clear/reselect stale hydration.

Extended existing `server/test/offline-downloads.test.ts` and `server/test/playback-sync-client.test.ts` assertions cover truncation, circular alignment and missed same-song playing commands. Existing real worker/auth/social/import/admin/privacy/transfer/SSE and five wrapper fixtures remain passing. The five initial new regressions were demonstrated failing on original application code before repair; baseline setup/mock errors were corrected separately and are described in TEST-RESULTS.md.

Headless Chromium was attempted but exited at launch with `socket() failed: Operation not permitted`; no real-renderer or Android notification acceptance is claimed. Node v24.22.3 and pnpm 10.14.0 were used; production Node 22/Docker acceptance remains necessary.

## Documentation sync

`HERMES_FOUND_BUGS.md` retains every historical report byte-for-byte, then appends the dated follow-up, new BUG-026 and an all-item disposition table. `CHANGELOG.md`, `TEST-RESULTS.md`, `DEPLOYMENT-NOTES.md` and `ACCEPTANCE-CHECKLIST.md` have current release sections. ARCHITECTURE.md needs no endpoint/DOM/schema update.

Current status wording:

> BUG-025 — RESOLVED IN SOURCE: unchanged budget-blocked windows retry after 30 seconds without changing the configured budget.
>
> BUG-026 — RESOLVED IN SOURCE: repeat-one jam timelines wrap correctly, circular drift avoids end/start oscillation, and same-song updates retain active media.
>
> BUG-007 / BUG-022 — UPDATED SOURCE TRANSITION FIXES; A07/A15 LOCKED-SCREEN ACCEPTANCE PENDING. Early complete audio and offline hydration, stale-pause filtering and source-preserving synchronization have automated coverage. Physical notification/audio continuity remains unverified.
>
> BUG-023 — SOURCE IMPLEMENTATION RETAINED AND TIGHTENED: declared-length truncation is rejected; real quota/eviction/PWA restart acceptance remains pending.

All other historical source fixes are retained and tested. Actual failed-import/provider reruns, live tunnel incident correlation, revised Discord SDK/profile deployment, Docker runtime and real PWA/storage/device checks are still external acceptance, not falsely closed bugs.

## Demo installation and rollback

1. Preserve the existing source/image and normal data/secret backups. Use the complete source ZIP in a fresh source directory, or use the clean patch against the exact baseline. Do not replay older patches included in repository history.
2. Preserve operator environment/compose/mounts and runtime volumes. Ensure the existing wrapper remains executable if the ZIP extractor discards Unix modes.
3. With pnpm 10.14.0 run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm --filter @musike/server bundle`. Build/run the real Docker image through the existing operator pipeline.
4. Refresh installed clients onto the new web/PWA assets/service worker. Preserve downloads and preferences; no site-wide data clear is required.
5. Test A07 and A15 ordinary playlist/radio for at least 30 minutes AND ten locked automatic transitions per Wi-Fi/mobile-data test, covering speakers/Bluetooth. Check notification persistence and manual locked Next/Previous/Play/Pause. Also test a downloaded playlist in airplane mode.
6. Test a real multi-account jam through at least three repeat-one cycles, queue additions, seek/pause, transfer and reconnect. Check absence of 0→1→0 oscillation and repeated seeks to duration. Test background jams separately because that was not part of the user's confirmed reproduction.
7. Run the remaining acceptance checklist before production promotion. A failed phone check leaves BUG-007/022 open; record the phone/browser version and visible/audible behavior even when no logs are available.

Rollback uses the prior matching source/image through the normal operator workflow; this revision changes neither server nor browser storage schemas. Keep existing downloaded audio and account data. Production promotion remains an operator action.
