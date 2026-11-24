# Current acceptance — prebuilt performance release, 24 November 2026

- [x] Full Node 22 suite with 189 passing tests, including the previously affected process and playback tests.
- [x] Library summary has playlist metadata and small artwork cards. Favorites membership remains complete and exact. One personal playlist or Favorites loads in full when opened.
- [x] DOM fixture selects track 117 from page two and retains all 125 tracks in the correct playback order.
- [x] Separate signed-in users cannot read a personal playlist, Favorites, summary, or membership from the other user's account.
- [x] ZIP bundle boots using Node 22 with no dependency installation. Served HTML, built JS, manifest and service worker. Auth-off JSON and fresh auth-on SQLite both validated using synthetic data.
- [x] Backup export shape and restore are preserved. Offline metadata reads, opt-in, history updates, legacy IndexedDB upgrade, and owner reset are covered by fixtures.
- [ ] Stage using a copied live database and the existing environment. Refresh the PWA and check upgrade, cached audio, backup/restore, old-asset rollback and device takeovers.
- [ ] Validate browser appearance, locked Android playback and provider connections on production-like devices before promotion.

---

# Current acceptance — performance overlay, 24 November 2026

- [x] Synthetic auth-enabled share paging covers deduplication, permission precedence, membership revocation, owner scoping and invalid sizes.
- [x] SQLite migration fixture verifies an existing database is backed up once, retained data survives reopen, four query plans use the new indexes and audit retention keeps 1,000 rows.
- [x] React DOM fixture covers the 36-card page limit, navigating to the next page, offline metadata and download behavior.
- [ ] Demo with a large playlist library on phone, desktop and TV. Verify filter, page navigation, focus in light/dark/custom themes, and the full queue when playing from a later track page.
- [ ] Run auth-on and auth-off backup/restore, favourites/history, download/pin, Google and public import, sharing/revocation, and the existing physical playback and provider acceptance checks below.
- [ ] Compare same-data API p50/p95 and browser interaction timings before and after. Confirm migration restart and test a matched server/web rollback in demo before promotion.

---

# Current acceptance — approved unresolved-issues revision, 24 November 2026

Checked items below refer to automated fixtures/builds only. Historical checklists remain below.

- [x] Baseline 165/165 tests; final full regression suite recorded in TEST-RESULTS.md.
- [x] Actual player/synthetic media: unlock while final probe is pending, deliberate pause cancellation, exhausted-no-successor pause, and ten hidden complete-body transitions preserving one output element and notification intent.
- [x] Actual browser coordinator modules/worker: two tabs share one installation/output; refresh handover keeps the row and rotates epoch; old epochs reject; another installation keeps its grant; closed SSE becomes offline and explicit takeover avoids failed acknowledgement wait.
- [x] Same-account forward seek propagation completes inside the fixture's one-second threshold; jam canonical push/permissions/repeat/transfer regressions retained.
- [x] Personal library deletion removes all own memberships/history/favourites, preserves other owners, strips local completed/pending pins/metadata, and rejects late audio/pin writes.
- [x] Actual React DOM confirmation using existing Modal: cancellation makes no write; confirm makes one deletion and one local purge. Motion is mocked; this is not visual acceptance.
- [x] Download exact incremental bytes/known totals; explicit Favourites pin/update retains completed bodies without duplicate download.
- [x] Google source endpoint IDs/numeric duration/metadata-only rows; queued/resolving progress and provider failures with safe reasons; matching/origin/idempotence and public importer regressions retained.
- [x] Account preference field merge/owner isolation/index access, backed-up/idempotent migration preserving normalization/revisions; browser no-echo, stale-response and offline-edit rejection fixtures.
- [ ] Samsung A07 installed PWA, normal playlist/mobile data: at least ten automatic locked transitions, especially third track; notification/audio persistence; unlock during loading, retry and final probe; intentional pause must remain paused. Repeat Wi-Fi/Bluetooth and radio.
- [ ] Physical two-device normal and jam seeking: target under one second awake/connected; capture request/receive/apply stages and audible timing. Test repeats, host/guest permissions and transfer during seeking.
- [ ] Close/crash old output; verify offline label, explicit takeover and epoch fencing. Half-open/unreachable output must not claim proved silence; normal reachable transfer requires acknowledgement. Refresh current output and open several tabs without duplicate device rows/sound.
- [ ] Favourites download/update/resume/cancel, unknown-size/failed progress, quota/budget/pins, and deletion while downloading/playing. Verify only initiating-installation audio is purged; remote downloaded bodies remain.
- [ ] Real Google consent/import (focus), provider denied categories, playlists/likes/albums/history, partial continuation, ambiguous replacements and retry. Every unavailable/unresolved item/category must be visible; no unsupported zero-miss claim. Repeat public playlist import/dedup.
- [ ] Change account appearance/language/normalization on A; B applies by heartbeat/reconnect; newer revisions win; offline edits cannot change server values; local volume/storage unaffected. Different accounts stay isolated.
- [ ] Real desktop/phone visual/focus/scroll acceptance. Chromium launch in the workspace failed before page load with socket permission denied; no visual result is claimed.
- [ ] Production Node 22 Docker build/startup, migration/backup/rollback and existing Discord/provider/tunnel acceptance, followed by operator demo approval before promotion. No deployment occurred.

---

# Current acceptance — approved source revision, 23 November 2026

These checked items are source/fixture/build results. Older sections remain historical evidence.

- [x] Full application/regression suite: 165 tests, no failed/skipped/cancelled.
- [x] Owner-only account preferences, Standard default/three-level validation, CSRF/auth checks, other-account isolation, heartbeat visibility, increasing revisions, transactional backup/idempotent migration/PK lookup and cascading deletion fixtures.
- [x] Real normalization DSP on synthetic samples: level matching across different amplitudes, ordered modes, bounded peaks, silence/invalid samples and stereo/reset; graph fixtures cover stable audio/video sources, independent volume/mute and safe initialization/processor failure paths.
- [x] Actual player with synthetic media: hidden automatic retry intent, downloaded fallback, no-downloaded pause, late-ended and stale-ended protection; existing pause/skip/output/repeat/jam regressions remain.
- [x] Three-body nearest-first preparation with one reader, retained successors and stale-window cancellation; existing byte limits/backoff/truncation tests pass.
- [x] One fresh source pass after confirmed rejected URL, no endless/rate-limit refresh, safe failure fields and non-resolving error probes.
- [x] Real React/DOM Library/TrackList: full metadata cards, grey interactive missing rows, no offline favorite writes, local-only playback queue and online download click without playback interruption.
- [x] IndexedDB v1-to-v2 preservation, opt-in snapshots, owner isolation, metadata limit retaining the previous snapshot, logout purge; existing audio admission/quota/pin/output fixtures pass.
- [x] Individual downloads queued during a playlist job are retained and remain unpinned.
- [x] Server/web typechecks, production web/PWA and server bundle; worklet emitted as fingerprinted JS and precached. No runtime dependency/CSS/operator-content change.
- [ ] Samsung A07 installed PWA: normal playlist on mobile data, at least 30 minutes and ten automatic locked transitions; retain notification controls and audible playback. Repeat with car/Bluetooth controls and rapid manual skips, then Wi-Fi.
- [ ] A07: intentional loss/restoration of connectivity; two bounded retries, next prepared/downloaded successor in order, pause if none remains; deliberate Pause/Next/Previous and output transfer must cancel pending recovery. Capture the new diagnostic categories and correlate with origin logs.
- [ ] Real audio: Quiet/Standard/Loud on streamed music, video, downloaded audio and jam output, volume slider/mute and silence, headset/Bluetooth, lock/unlock and external audio interruption. Verify no silence from a suspended/failed graph and no unwanted extra output. DSP/mock tests are not physical audio acceptance.
- [ ] Two real devices on the same account: normalization change propagates on heartbeat/reconnect without changing device volume; another account remains unchanged. Offline retains last synced level; edits require online connectivity.
- [ ] Real narrow/wide/TV visual/focus/scroll review. Offline Library/Favorites/history/personal playlists/all-downloads navigate correctly; grey tracks explain unavailability; online explicit download does not start playback or silently pin. Existing Modal/import behavior remains.
- [ ] Upgrade a real populated PWA without clearing data; verify downloaded bodies/pins, metadata quota rejection, browser persistence denial and explicit logout of one account. Exercise two-tab Web Lock contention, ineligible output and reconnect/auth-failure races.
- [ ] Actual Node 22 Docker image/startup migration, consistent backup and rollback, including browser IndexedDB v2 compatibility. Keep existing outstanding provider/import/Discord/tunnel checks below.
- [ ] Operator demo acceptance and separate production promotion. No deployment performed here.

---

# Current acceptance — all-issues review and playback repair, 20 November 2026

Baseline: `musike-main (7).zip`, SHA-256 `625ca84bc7115064a867eac89da4d59a76d47bcb92077a2abcc54dcbff8e4d96`. This section supersedes older source-result counts; earlier records remain historical evidence.

- [x] Original 138 tests pass after restoring the ZIP-lost wrapper executable permission; final 149 tests pass, zero failed/skipped/cancelled.
- [x] Unchanged budget-blocked window recovers after 30 seconds with released space, without changing queue/budget; no immediate retry thrash.
- [x] Server and actual browser coordinators: repeat-one modulo across multiple cycles, circular drift, immediate host discontinuity publication, stale progress rejection, host/guest permissions and output fencing.
- [x] Actual player with synthetic media: native repeat wraps, same-source jam updates, stale pause events, offline prehydration and complete next-body handoff before server readyIds.
- [x] Preload retry backoff, unavailable optional storage, clear/reselect generation fencing and truncated-body rejection in preload and persistent downloads.
- [x] Server/web typechecks, production web/PWA and server bundle; runtime manifests/lockfile/CSS/schema/endpoint/operator configuration unchanged.
- [ ] Samsung A07 AND A15: ordinary playlist and radio, at least 30 minutes AND ten automatic locked transitions in each Wi-Fi/mobile-data test; verify audible playback and notification persistence. Include speakers and Bluetooth. Manual locked Next/Previous/Play/Pause must also be tested, because they were not previously checked.
- [ ] Both phones: downloaded playlist in airplane mode, lock and cross multiple boundaries; unlock and verify queue/position. Repeat-one should keep playing without source replacement.
- [ ] Two real jam accounts: repeat-one for at least three cycles, seek/previous/next, add queue items during playback, pause/resume, transfer and reconnect; no 0→1→0 oscillation or repeated end seeks. Locked jam playback has not yet been tested by the user.
- [ ] Demo cache-budget pressure: release active streams/space and verify an unchanged queue resumes warming after backoff.
- [ ] Retain the outstanding real failed-import/provider, Discord SDK/profile, PWA quota/eviction/reopen, tunnel correlation and Docker/runtime checks below. Automated fixtures do not close these external acceptance items.
- [ ] Operator demo verification and approval before production promotion. No production deployment performed here.

---

# Current acceptance — background/offline source revision, 20 November 2026

Base `c1293caa`. Checked items are fixtures/build checks, not deployment or physical-device claims.

- [x] 138 tests; actual React SVG click path, clean jam/remote payloads and Hermes transfer/SSE/guest-control regressions.
- [x] Stable audio element for hidden ended/manual next; intent-aware loading, play/pause, bounded retry and stale source cancellation fixtures.
- [x] Async owner-scoped IndexedDB, exact audio byte accounting, concurrent admission, oldest-unpinned eviction, pinned/pending protection, lower-budget stop and logout isolation.
- [x] Complete audio-only HTTP 200 admission; reject partial/video/HTML/empty bodies; interrupted checkpoint/resume without refetching completed tracks.
- [x] Offline account reopening only after network failure; known 401/challenge/pending logout cannot authorize fallback; cached role/phone restrictions.
- [x] Typechecks, production web/PWA build, server bundle, pnpm 10 frozen lockfile install and clean source patch/archive verification.
- [ ] Samsung A07 installed Chrome PWA: ordinary playlist and radio × Wi-Fi and mobile data; ten consecutive automatic locked transitions each, notification persistence, manual next/previous, repeated Play and deliberate Pause while loading. Record trace IDs and audible gaps.
- [ ] Real PWA: enable each budget; pin/download audio including a video catalog item; verify no video endpoint/bytes; airplane mode, app close/reopen, play/seek/repeat/shuffle and downloaded playlist availability.
- [ ] Interrupt download/network or close tab, reopen and explicitly resume. Edit a pinned personal playlist and verify Updates available without automatic bulk download; complete update without losing the previous copy.
- [ ] Fill/lower budget with pins; verify no pinned eviction, visible incomplete state, oldest-unpinned removal and separate total-site estimate. Exercise actual browser QuotaExceededError/persistence denial/site eviction.
- [ ] Two accounts in one browser: isolate downloads, clear/log out one owner, preserve the other. Offline logout then reconnect must finish server logout before accepting the cookie again.
- [ ] Two tabs and two devices: last designated installation only, exclusive offline tab lock, rejected unsupported lock, pause-before-reconnect and fresh online ownership. Exercise explicit remote takeover during a disconnection under the accepted partition limitation.
- [ ] Phone narrow viewport, keyboard, focus, safe-area/scroll and long import reports; keep the Hermes modal and removed backup button behavior.
- [ ] Actual Docker image build/run, real providers/Discord regression and production promotion through the operator's existing pipeline. No deployment performed here.

---

# Current acceptance — expanded web/PWA revision, 19 November 2026

The earlier checklists below are historical evidence. Current automated results and limits are in TEST-RESULTS.md.

- [x] Retired application directories/native build wiring removed; source Docker inputs updated; remaining dependency versions preserved.
- [x] Friend acceptance, phone privacy, opt-in presence, group ownership, shared viewer/editor authorization, stale-edit rejection and revocation/copy fixtures.
- [x] Ordered public import, duplicate prevention, partial failure, progress before completion, owned checkpoints and cancellation fixtures.
- [x] Direct admin Malaysian phone edit, collision/foreign rejection, session/challenge invalidation, guarded permanent deletion and cascading cleanup fixtures.
- [x] Same-account browser coordinator fixtures plus cross-account jam queue/controls/host loss, single-output permissions and drift correction fixtures.
- [x] Complete preload byte bounds/retention, hidden retry/unlock recovery, cancellation, stale-device takeover and false-SSE-liveness regression fixtures.
- [ ] Samsung A07: playlist and radio × Wi-Fi and data, ten locked transitions per combination, deliberate pause/skip, unlock recovery and memory behavior.
- [ ] Two real accounts/devices: invitation, separate output selection, guest queue addition, foreground alignment near one second, host disappearance/claim and reconnect/autoplay behavior.
- [ ] Real 50-video public YouTube playlist: usable tracks in source order, progress, private/unavailable reporting and duplicate-free rerun. No Google credentials used.
- [ ] Real PWA install, phone/wide/TV UI, reader/keyboard/focus behavior, narrow-screen admin forms and shared editing.
- [ ] Actual Docker image build/run and data migration/backup/rollback through the operator pipeline.
- [ ] Official Discord SDK build and revised service regression: Ready/profile, pause/transfer/second user and no vendor file logs.
- [ ] Correlate Samsung trace IDs with origin/tunnel/Access/WAF logs before attributing the remaining incident cause.
- [ ] Approve production promotion separately; this package changes source only.

---

## Historical acceptance records

# Acceptance checklist — fork plus 19 November bugfixes

Checked boxes below refer to automated fixtures/build checks performed for this package. Unchecked boxes require the operator's demo, external provider or physical device. They are not implied successes.

## Phase 1 — Queue pre-caching

- [x] Primary refusal falls back to complete cached audio bytes; warm hits do not re-resolve URLs.
- [x] Direct candidate is usable while a primary wrapper resolution remains pending.
- [x] Warm HTTP audio serves exact local-file Range bytes without upstream work.
- [x] Shared audio/HD usage accounting, active leases, budget stop/no-thrash and rapid-skip cancellation fixtures pass.
- [x] Server lookahead is validated/persisted; older queue-window revisions cannot replace newer skips.
- [x] Pure ordered/manual/repeat-all window regression passes; web/native/desktop code compiles.
- [ ] Measure warm primary and direct-fallback playlist/radio advances against the same local-file baseline on demo; record browser timings and audible gaps.
- [ ] Exercise real radio tail filling, optimistic queue insertion/removal, shuffle/repeat, rapid skips and concurrent clients under the deployed cache budget/wrapper.
- [ ] Verify cold-path 403 behavior and keep/remove the existing wrapper only from measured evidence. This package does not certify BUG-001's upstream cause is fixed.

## Phase 2 — Accounts, OTP and migration

- [x] Migration backup/exact original preservation/idempotent restart and malformed-source failure pass.
- [x] ADMIN_PHONE first-login bootstrap, invite-only creation, per-user isolation and single-use codes pass.
- [x] Cooldown, expiry, attempt cap, concurrent resolved-IP request limit and wasphere contract/no automatic 408/5xx retry pass with injected providers.
- [x] Secure cookie issuance, access refresh, server logout, disabled-user revocation, last-admin guard and API login wall/CSRF pass.
- [x] Auth-off legacy library/static/media tests remain green.
- [ ] A real wasphere OTP arrives for the configured admin; migrated data appears; an invited second account starts empty; uninvited phone receives no message.
- [ ] Verify actual HTTPS cookie/remember-me expiry/logout, backup/restore and failure recovery on the NAS volume.
- [ ] Run bundled promotion/revocation against demo and confirm access from a separate browser; ensure last admin cannot be removed.
- [ ] Verify hosted Android/iOS/TV cookie login, session-loss media stop and background playback. Standalone local mode remains independent.

## Phase 3 — Admin and ops

- [x] Non-admin APIs return 403 for settings/users/ops/system controls; settings validate and survive app restart.
- [x] Two distinct authenticated clients appear in ops; disabling a user removes their session/presence.
- [x] Direct/unconfigured, trusted XFF, trusted CF and untrusted-spoof cases attribute expected IPs in both presence and audit.
- [x] Admin actions emit IP-attributed structured logs and retained audit rows; sensitive request queries/headers are not serialized.
- [ ] Confirm all four panels are absent for a non-admin; exercise edits in dark/light themes and narrow/TV layouts.
- [ ] Open a second real browser, confirm the live count within seconds, and verify actual tunnel client IPs instead of the Docker bridge address.
- [ ] Verify persisted cache/lookahead/quality/arguments and OTP controls on restart; inspect server logs for audit attribution without credentials.

## Phase 4 — Google import

- [x] Fixture OAuth state single use, PKCE scope, owner-bound callback and encrypted stored tokens pass.
- [x] Ordered playlists, album-origin playlists, likes and latest-history fixture imports report per item and rerun without duplicates/resolution work.
- [x] A second user's import never changes the first user's library; refresh credentials survive reopen/restart.
- [x] Unavailable categories return partial reports; matching rejects an arbitrary wrong-artist search result.
- [x] Daily sync is off by default, per-user opt-in/opt-out is enforced and disconnect revokes/deletes credentials in fixtures.
- [ ] Configure Google Cloud test users/client/HTTPS redirect and perform real consent, refresh and revocation. Never copy actual tokens into acceptance evidence.
- [ ] Import a small real library and verify all four categories actually granted by the provider. Albums/history use private Music APIs and may be refused; public API fallback covers playlists/likes only. Record unavailable categories as unresolved acceptance, not empty successful imports.
- [ ] Verify idempotent manual top-ups, imported-origin UI labels, restored/edited collections and independent second-user consent/import on demo.
- [ ] Opt in only one demo user, advance/wait for the real daily schedule and confirm no other account syncs. Google may reject embedded WebView consent; use a regular browser for connection.

## Delivery/build scope

- [x] Full suite, TypeScript checks and web/PWA, native-mode, server and Electron bundles pass; see TEST-RESULTS.md for exact results.
- [x] ZIP is a changed/new-file source overlay; operator-owned .env, compose and deployment files, credentials, dependencies, caches/DBs and generated bundles are excluded.
- [ ] Build/run the actual Docker image and native installers with the operator pipeline and verify architecture-specific Node/device behavior. No production deployment was performed here.


## 19 November — BUG-002–006 regression acceptance

- [x] Unicode/artist/duration/version/ambiguity matching tests and original-ID/ordered fallback fixtures.
- [x] Live owner-scoped progress before job completion; bounded report deltas; review candidates/provider failures; idempotent retry and preserved restart checkpoints.
- [x] Cold first-usable-byte race, stalled primary cancellation, byte ranges, 416, admission bounds and cancellation/shared resolver ownership.
- [x] Actual Zustand player code exercised with synthetic media: playList, manual mutations, jump/shuffle/repeat, hidden ended handoff, stale radio results, transient recovery and autoplay fallback.
- [x] Request trace isolation, HTML/opaque-redirect/challenge/error classification, telemetry bounds/redaction/auth wall and owner-scoped non-resolving probes.
- [x] POSIX wrapper success/arguments, transient retry cap/clean stdout, fatal/pass-through behavior, explicit delay override and signal reaping.
- [x] Full tests/typechecks and web/native/server/desktop bundles pass; exact results in TEST-RESULTS.md. CSS, dependencies, DB schema and other deployment files unchanged.
- [ ] Re-run the actual failed Takeout/Google input; this source contains no Takeout adapter or the 387-item failed export. Record genuine unavailable/review counts and verify selected replacements.
- [ ] Capture real radio-stall timing with diagnostics enabled; correlate browser trace/Ray IDs, origin stages and Access/WAF/tunnel records.
- [ ] Test the reported Android PWA with screen off across at least ten transitions, plus manual next, rapid skips, pause/resume, online recovery and app restart. Synthetic hidden visibility is not physical-device evidence.
- [ ] Compare wrapper legacy-delay and override-zero modes on demo, with real primary/direct fallback/403 behavior. Preserve rollback until measured.
- [ ] Confirm source-only overlay installation keeps the approved wrapper executable, all operator-owned settings/mounts intact and owner/session isolation functional. No production deployment was performed here.

## 19 November — BUG-007–012 and account playback sync

- [x] Actual player fixtures exercise hidden playing→waiting→position-preserving recovery and pause/skip cancellation.
- [x] Phone normalization/backfill/backup, invalid/foreign rejection, canonical collisions and idempotence fixtures.
- [x] Real server sync policy plus two real browser coordinator modules verify remote controls and pause-before-transfer ordering, stale-write rejection and owner/session isolation.
- [x] Discord OAuth PKCE/single-use/owner state, encrypted tokens, identity uniqueness, playback/clear/disconnect and log redaction fixtures.
- [x] Internal service HTTP authentication, capacity/worker cleanup and log redaction with a mock SDK process.
- [ ] Samsung A07 physical playlist/radio × Wi-Fi/mobile-data, ten consecutive locked transitions per combination, including sustained progress after handoff.
- [ ] Real origin/tunnel/Access/WAF correlation for the reported or newly captured stall.
- [ ] Real cross-device autoplay, transfer/offline/close/restart/disable/session-expiry and narrow-screen UI acceptance.
- [ ] Official vendor SDK compilation, app eligibility, headless Ready, two users' real Discord profiles and absence of vendor-created log files.
- [ ] Hermes separate platform retirement commit and Docker image acceptance.
- [ ] Azan approval before production promotion or Cloudflare/tunnel changes.
