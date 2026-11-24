# Musike source revision — impact and handoff, 24 November 2026

## Scope and decisions

Authorized: all unresolved source issues, prioritizing Google import and the supplied normal-playlist/mobile-data trace. Preserve earlier fixes. The user approved one account/browser installation identity, derived names without renaming, safe automatic refresh resume, bounded recovery/downloaded successor fallback, explicit Favourites updates, per-track byte progress, local-only download deletion and account-shared appearance preferences. Deleting the current track stops it and strips this installation's queue occurrences. Production deployment is not included.

## Exact source file/function impact

| Files | Modified functions/wiring and purpose |
| --- | --- |
| `web/src/player/player.ts` | `load`, `report`, `downloadedFallback`, `onError`, `wire`, `toggle`, `restorePlayback`; new `musike:track-deleted` listener. Unlock/probe race and transport classification, existing context foreground recovery, local deletion. |
| `web/src/lib/playbackSync.ts` | `startPlaybackSync` installation wrapper; extracted existing `startCoordinator`; `deviceName`, `receive`, action patches, `connect`, cleanup, `publishNow` instrumentation. Exclusive per-installation tab coordination, stable row/refresh, immediate seeks, bounded diagnostics. |
| `server/src/playbackSync.ts` | `register`, `subscribe` cleanup, `reconcile`; optional instance fencing, immediate disconnected liveness, consistent transfer expiry. |
| `server/src/playbackRoutes.ts` | Registration body passes optional `instanceId`. |
| `web/src/lib/jams.ts` | `playJamHere`: event-driven grant waiting and explicit stale claim. Existing canonical jam push retained. |
| `web/src/components/PlaybackDevices.tsx` | Offline status takes precedence over active designation; explicit stale takeover not disabled by stale pending transfer. |
| `server/src/library.ts` | New factory/facade `deleteTrack`; remove all personal references via existing serialized persistence. |
| `server/src/app.ts` | Owner-scoped `DELETE /api/library/tracks/:id` wiring. |
| `web/src/lib/apiTypes.ts`, `web/src/lib/api.ts` | `MusikeApi.deleteTrack` and HTTP implementation. |
| `web/src/stores/libraryState.ts` | `deleteTrack` through existing optimistic ordered writes. |
| `web/src/components/TrackMenu.tsx` | Confirm deletion in existing Modal, stop local queue track and purge initiating-installation download. |
| `web/src/lib/offlineStore.ts` | New `removeOfflineTrack`; `saveOfflineAudio`, `writeOfflinePin` reject locally deleted late completions; optional bounded marker field in existing settings. |
| `web/src/lib/offlineDownloads.ts` | `fetchCompleteAudio`, `drain`, cancellation progress; `downloadOfflineTrack`/`pinOfflinePlaylist` explicitly clear selected markers; new `deleteLocalAudio`. |
| `web/src/stores/offline.ts` | Typed current-batch per-track progress in existing worker store. |
| `web/src/components/OfflineStorage.tsx` | Shared paginated status/bytes/known-size percent view. |
| `web/src/views/Collection.tsx` | Favourites virtual playlist passed to existing pin button. |
| `server/src/googleSource.ts` | `sourceTrack`, `complete`, `googleMusicSource`: endpoint-only/missing-ID metadata, numeric durations, partial continuation retention and per-collection public supplementation. |
| `server/src/googleImport.ts` | `resolve`, `run` and report progress types: anonymous original fallback, safe unresolved reasons, one resolving + up to 100 queued previews. |
| `server/src/playlistImport.ts` | `run`, `status`, `resume`: visible resolving/reason, deadline race and resumable in-flight checkpoints; skipped entries remain partial. |
| `web/src/components/AccountPanel.tsx` | Google progress types/rendering for current resolving and bounded queued preview. |
| `web/src/components/PlaylistImportDialog.tsx` | Existing compact report displays resolving and safe failure reason. |
| `server/src/db.ts` | Worker-backed transactional `account-appearance-v1` migration/backup. |
| `server/src/accounts.ts` | `preferences`, `setPreferences`: owner-keyed validated field merge and revisions. |
| `server/src/accountRoutes.ts` | Existing PATCH schema admits agreed appearance/language fields. |
| `web/src/lib/accountPreferences.ts` | New `startAccountPreferences`: no-echo store subscriptions, explicit patches, revision/owner fences and offline reversion. |
| `web/src/stores/session.ts`, `web/src/App.tsx` | Preference type extension and post-AuthGate lifecycle start/cleanup. |
| `web/src/i18n/en.ts` | Typed download/import/deletion labels; Portuguese inherits existing English offline catalog fallback. |
| `deploy/ytdlp-wrap.sh` | Executable metadata only; exact content retained. |

## Validation and limits

See TEST-RESULTS.md for the final exact counts/commands. Tests exercise real stores/coordinators/workers and synthetic media, plus real React DOM with Motion mocked for deletion. Browser visual smoke was attempted but Chromium could not launch because this environment denies its singleton socket. Actual Samsung notification/audio behavior, physical seek/takeover latency, browser autoplay, Google/private-provider coverage, Discord SDK and Docker/operator acceptance remain pending.

No runtime dependency/lockfile/CSS/operator configuration change. No credentials or live provider account were used. No deployment. Missing provider access cannot be turned into guaranteed availability; unresolved items remain explicit and uncertain replacements remain reviewable.

## Delivery

Use the complete source ZIP OR the clean patch against the exact uploaded ZIP baseline, not both. Historical patches inside the repository are evidence; do not reapply them. The delivery includes complete source files, regression tests and synchronized docs, with no placeholders or generated bundles. Baseline ZIP SHA-256: 5271972bc2597149118925838fa3145eda01880f65ee61043e1aa2d473c8c7ca.

New server migration is additive and backed up; IDB remains version 2. Preserve data/secret backups and existing downloaded audio during upgrade. Follow the current DEPLOYMENT-NOTES.md and ACCEPTANCE-CHECKLIST.md before promotion.
