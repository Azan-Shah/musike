# Musike performance audit and rollout

24 November 2026 · Source reviewed and refactored from `musike-main (10).zip`.

## Results

| Path | Finding | Delivered change |
|---|---|---|
| Initial Library loading | Bootstrap transferred every track in every playlist | Startup now fetches the Library summary. A selected playlist or Favorites loads in full on demand. |
| Social page with 200 incoming shares | Looked up each share and its permissions separately | One query evaluates all grants on the page. With warm owner snapshots, total worker calls fell from 408 to 7 per Social state request. |
| Library incoming shares | Loaded full Social state and up to 200 grants just to render summaries | Uses `GET /api/social/shares` with 30 grants per page, cancellation on navigation, and summary fields only. |
| Personal playlists | Library cards and rail links mounted for every playlist | Library renders up to 36 playlist cards and the rail up to 30 links at a time. Library adds a case-insensitive name filter. Each rail page remains reachable through compact controls. |
| Collection and download progress | Broad subscriptions repeated list and pin work during unrelated updates | Memoized track list and cards, stable membership indexes, and download subscriptions scoped to fields the component consumes. |
| SQLite cleanup | Missing indexes on four maintenance predicates and an audit trim that examined the full table | Targeted indexes, up to 128 reused prepared statements, and indexed audit retention in the insert transaction. |
| UI consistency | Base focus changed control shape and the raw accent could have poor contrast on light surfaces | Normal and TV focus use the contrast-adjusted accent token. Secondary buttons and links share alignment and disabled behavior. Cards and panels use existing radius tokens. |
| Tool update path | Tool discovery performed synchronous filesystem calls on the server thread | Asynchronous filesystem discovery preserves tool precedence. |

The provided archive contains Fastify and TypeScript, React with Zustand, and Tailwind CSS. Accounts use SQLite in a dedicated worker. Shared-library mode uses a JSON file. The prebuilt release follows those source boundaries and reuses the existing component, store, and token patterns.

The web source had zero matches for app-level `innerHTML` assignments or `dangerouslySetInnerHTML`. The expensive pattern was React mounting every keyed card or link and running collection-wide derivations on unrelated updates. The static `index.html` has a small pre-paint theme script. Existing track, selection, and queue lists already page their mounted rows.

### Measured locally

The benchmark used 200 direct share grants from one owner, warm libraries, and 40 alternating service calls per variant on Node 24. Both versions used the same database and worker. It measured the Social service method, excluding HTTP, transfer, cold disk and browser rendering.

| Variant | SQLite worker calls | Median | p95 |
|---|---:|---:|---:|
| Uploaded Social service | 408 | 27.35 ms | 35.68 ms |
| Revised Social service | 7 | 1.28 ms | 1.97 ms |

The new Library share page used one worker call and returned 30 rows in the same warm fixture. A cold page can still load one complete snapshot per represented owner. React DOM tests verified the 36-card limit, page navigation and filtering across 75 playlists. SQLite `EXPLAIN QUERY PLAN` selected each of the four added indexes in the fixture.

On the compiled Node 22 server in auth-off mode, a fixture with 120 playlists, 30,000 playlist entries, 900 Favorites and 60 recent tracks returned 5,976,398 bytes through the full Library endpoint and 88,254 bytes through the startup summary. That is a 98.5% reduction in uncompressed response size for that fixture. Actual transfer size and interaction latency depend on the library and deployment.

## Endpoint audit

Reviewed all 90 explicit API registrations in the upload plus the five additive incoming-share and Library registrations. Paths below are relative to `/api`. The reviewed SQL executes in the SQLite worker and uses parameter binding. An async route may still do synchronous JSON, validation, or other CPU work in the Fastify process.

| Methods and paths | Execution and findings |
|---|---|
| GET `/health`; GET `/system`; POST `/system/ytdlp` | Health payload is constant-size. Admin system reads use cached/coalesced version and release probes. Tool jobs share active work. Switched request-triggered file discovery and the tar check to async I/O. |
| GET `/search`, `/suggest`, `/search/albums`, `/video-for/:id` | Provider-driven. Suggestion and search inputs are bounded and video matching is memoized. Search fallbacks can add latency, and provider response time should be measured separately from SQLite. |
| GET `/radio/:id`, `/genres`, `/genres/:gid`, `/genres/:gid/artists`, `/artists/:aid`, `/albums/:alid` | Radio has a deadline and disconnect handling. Browse uses bounded result caches, and genre artists are paged. Artist and album detail responses can still contain their full provider result. |
| GET `/playback/settings`; POST `/playback/events`, `/queue/prepare`, `/prepare/:id`; GET `/stream/:id/audio`, `/stream/:id/video` | Small settings response, bounded telemetry payload and media warm queues, subprocess admission limits, async range/media I/O. First-byte and transfer timing depend on cache and provider paths. Authenticated streams use the indexed session lookup and then resolve media through the existing caches and provider paths. |
| GET `/library`, `/library/tracks`; POST `/library/import`; DELETE `/library/tracks/:id` | Full snapshots support export, restore, and opted-in offline metadata. Track pages cap responses at 200. The release keeps exact filtered totals with a single scan and allocates only the matching page. Bulk JSON parse/serialize and full snapshots remain scaling costs. |
| GET `/library/summary`, `/library/favorites`, `/playlists/:pid`; POST `/library/playlist-membership` | Startup uses playlist metadata, Favorites IDs and limited previews. Detail requests load one complete collection. The membership response returns only personal playlist IDs. |
| PUT and DELETE `/favorites/:id`; POST `/favorites`, `/history`, `/playlists`, `/playlists/:pid/tracks`; PATCH and DELETE `/playlists/:pid`; DELETE `/playlists/:pid/tracks/:id` | Existing per-owner library state and serialized snapshot persistence apply. Bulk adds and recent history are bounded. Whole-snapshot serialization and large mutation responses can dominate at higher track counts. |
| GET `/auth/me`; POST `/auth/request`, `/auth/verify`, `/auth/logout`, `/presence`; PATCH `/account/preferences` | Session lookups use unique access/refresh hashes. OTP phone/IP indexes already support rate checks. Added created-time OTP cleanup and session-hash client cleanup indexes. Presence groups its writes in one short transaction. OTP delivery awaits the provider outside SQLite. |
| GET and PATCH `/admin/settings`; GET `/admin/users`, `/admin/ops`; PATCH and DELETE `/admin/users/:id`; POST `/admin/invites` | User and client responses already use bounded offset pages. User ordering and active-client predicates have indexes. Ops still counts active users and calculates cache usage. Audit retention uses the primary-key range and now shares the insert transaction. |
| POST `/playback/devices`, `/playback/sync`; GET `/playback/state`, `/playback/updates` | Account playback snapshots are keyed by owner and serialized with bounded queues. SSE retains only the latest pending update under backpressure. Large snapshots still contribute JSON and network work; retain ownership and transfer semantics when profiling. |
| POST `/google/connect`, `/google/import`, `/google/sync`, `/google/disconnect`; GET `/google/callback`, `/google/status` | OAuth state cleanup and recovery of running reports use the new indexes. OAuth/provider waits occur outside DB transactions. Status exposes bounded progress deltas. Import worker still checkpoints report JSON and may load many existing source mappings per owner. |
| POST and GET `/playlist-imports`; GET `/playlist-imports/:id`; POST `/playlist-imports/:id/resume`, `/playlist-imports/:id/cancel` | Background job queue and per-owner active-job constraint apply. Entry paging uses the primary key on run and position. Per-item status writes are durable progress checkpoints for resumable work. |
| GET `/social`, `/social/shares`; POST `/social/friends`, `/social/requests/:id`, `/social/groups`, `/social/shares`; DELETE `/social/friends/:id`; PATCH `/social/preferences`, `/social/groups/:id`; GET `/social/groups/:id` | The former per-share grant loop is now one scoped query. Direct and group grant indexes support the two inputs. Friends, requests, groups and owned shares are bounded. The existing Social refresh cadence remains five seconds while the view is mounted. |
| GET, PATCH and DELETE `/shared-playlists/:id`; POST `/shared-playlists/:id/copy` | Indexed share and grant lookups for a single collection, scoped by the requesting account. Edits preserve revision checks and copies retain their own track data. Full detail is used for editing and playback. |
| GET and POST `/jams`; POST `/jams/join`; GET and PATCH `/jams/:id`; POST `/jams/:id/output`, `/jams/:id/invite`, `/jams/:id/leave`, `/jams/:id/claim`, `/jams/:id/commands` | Room, member and invite lookups use indexed keys. Bounded membership fan-out is part of publishing to each account. Account deletion now fetches owned rooms and guest IDs in one SQL call. |
| GET `/discord/status`, `/discord/callback`; POST `/discord/connect`, `/discord/disconnect`; GET `/youtube-history/status`; POST `/youtube-history/connect`, `/youtube-history/disconnect` | Owner-keyed connections and OAuth state indexes already exist. Most slow work is external provider or adapter I/O. |
| Static files and SPA fallback | Fingerprinted assets use immutable caching and HTML is revalidated. Authenticated API responses use `no-store`. |

### SQLite and concurrency

One worker owns a SQLite connection and serializes database operations off the Fastify event loop. Keep one application process per data directory, since the app also keeps writable library state in memory. WAL, foreign keys, FULL durability, and the five-second busy timeout remain part of that contract. The timeout is set before journal-mode initialization. Worker transactions contain SQL only, and network work stays outside them. Prepared statements are cached by SQL within the connection, with a 128-entry cap.

`query-performance-v1` adds `otps_cleanup_time`, `oauth_states_expiry`, `clients_session`, and the partial `import_runs_running` index. On an existing database, the worker writes a consistent mode-0600 backup next to the database before starting one immediate transaction for the indexes and marker. A second startup skips the migration. The index-only change is compatible with the prior server build.

## Apply safely

1. **Prepare a staging copy.** Use the exact uploaded source as the baseline. Its ZIP SHA-256 is `395a7ac2141a7cf9f018357882456844f855621896da6d8cc02802d3c5b36905`. Keep the previous matched server image and web assets. Take a consistent backup of app data and the instance secret using your existing procedure. Preserve the operator environment, compose settings, wrapper and browser site data.
2. **Extract the complete ZIP to a fresh staging directory.** The source already includes the refactor, and the paired build outputs are under `server/dist/` and `web/dist/`. Follow `START_HERE.md` to run the included server locally.
3. **Rebuild the source when needed.** The full suite and builds were verified with Node 22.23.5 and pinned pnpm 10.14.0.

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm test
   corepack pnpm typecheck
   corepack pnpm build
   corepack pnpm --filter @musike/server bundle
   ```

4. **Start the new server in staging.** Start with a copy of an auth-enabled database, confirm a `*.before-query-performance-*.sqlite` backup is created, then check the marker and indexes using a read-only SQLite connection. Restart once and confirm no second performance backup is created. Run an auth-off instance against a copy of the shared JSON library too.

   ```sql
   SELECT key, value FROM migrations WHERE key = 'query-performance-v1';
   SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
     'otps_cleanup_time', 'oauth_states_expiry', 'clients_session', 'import_runs_running'
   ) ORDER BY name;
   ```

5. **Refresh the staging PWA and verify normal flows.** Use a library with enough playlists for multiple pages. Check the name filter, sidebar and Library pages, keyboard/TV focus, light and dark themes, and access to later pages. Play a track on a later track page and verify the full playlist queue. Verify favorites, history, downloads and pins, backup/restore, shared view/edit/revoke, and Google/public import progress. Re-run the existing physical playback and device transfer acceptance in the repository checklist.
6. **Compare before and after on the same data.** Record warm and cold response sizes and p50/p95 for `/api/library/summary`, `/api/library`, `/api/social`, and `/api/social/shares`. Capture time from Library navigation to the first interactive page, plus page/filter interactions on the phone. Use an origin trace for playback and provider calls so remote latency stays visible.
7. **Promote or roll back as a matched release.** Roll out the server and browser assets together or start the new server before the new assets. If staging regresses, restore the prior matched server and assets. The old server can use the added indexes. Only restore the data backup if needed and account for any writes after it was taken. Keep the existing version-2-compatible PWA rollback path to preserve offline downloads.

### Remaining scaling costs

Startup still sends compact metadata for every playlist and the IDs of all Favorites so the UI can preserve name filtering and membership checks. Selected playlists and Favorites are fetched whole for playback and pinning. A cold server still loads the underlying entire persisted library. Large mutations, backup operations, and full offline metadata remain scaling costs. The filtered track endpoint still scans the selected collection for an exact count, and high share offsets still do grant work before producing the page.

The complete suite passed 189 of 189 tests on Node 22.23.5, together with type checks and both builds. The process fixture removes the environmental proxy warning from its print-only child. Playback lifecycle fixtures keep their awaited timers alive through teardown. The YouTube history fixture waits for its queued SQLite lookup before advancing the test clock. The extracted builds passed checks for HTTP startup, auth modes, SQLite migration and PWA assets using test data.

Browser rendering, physical device operation, live providers and Docker deployment remain staging checks.

## Exact code excerpts

### Paged playlist filter

`web/src/views/Library.tsx`

```tsx
  const [query, setQuery] = useState("");
  const term = useDeferredValue(query.trim().toLocaleLowerCase());
  const filtered = useMemo(() => term ? playlists.filter(p => p.name.toLocaleLowerCase().includes(term)) : playlists, [playlists, term]);
  const page = useListPage(filtered, JSON.stringify(["library", user, local, term]), 36);
```

### Bounded pagination hook

`web/src/hooks/useListPage.ts`

```ts
export function useListPage<T>(items: T[], identity: object | string = items, pageSize = ROWS_PER_PAGE) {
  const [state, setState] = useState(() => ({ identity, page: pages.get(identity) ?? 0 }));
  const requested = state.identity === identity ? state.page : pages.get(identity) ?? 0;
  const page = Math.min(requested, Math.max(0, Math.ceil(items.length / pageSize) - 1));
  const start = page * pageSize;
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(page + delta, Math.ceil(items.length / pageSize) - 1));
    pages.set(identity, next);
    setState({ identity, page: next });
  };
  return { start, end: Math.min(start + pageSize, items.length), items: items.slice(start, start + pageSize),
    previous: () => move(-1), next: () => move(1) };
}
```

### Batched share access and summaries

`server/src/social.ts`

```ts
  async incomingShares(user: string, offset: number, limit: number) {
    const rows = await this.accounts.db.all<{
      id: string; owner_id: string; owner_name: string; playlist_id: string; can_edit: number;
    }>(`
      WITH grants AS (
        SELECT share_id, permission FROM playlist_grants WHERE user_id=?
        UNION ALL
        SELECT g.share_id, g.permission FROM group_members m
        JOIN playlist_group_grants g ON g.group_id=m.group_id WHERE m.user_id=?
      )
      SELECT s.id, s.owner_id, u.name AS owner_name, s.playlist_id,
             MAX(grants.permission='editor') AS can_edit
      FROM grants JOIN shared_playlists s ON s.id=grants.share_id
      JOIN users u ON u.id=s.owner_id
      WHERE s.owner_id<>? AND u.status='approved'
      GROUP BY s.id
      ORDER BY s.id LIMIT ? OFFSET ?
    `, [user, user, user, limit + 1, offset]);

    // Read each owner's live snapshot once, including changes that have not yet flushed to SQLite.
    const byOwner = new Map<string, Map<string, { name: string; tracks: number }>>();
    const shares = [];
    for (const row of rows.slice(0, limit)) {
      let playlists = byOwner.get(row.owner_id);
      if (!playlists) {
        const library = await this.accounts.library(row.owner_id).getLibrary();
        playlists = new Map(library.playlists.map(p => [p.id, { name: p.name, tracks: p.tracks.length }]));
        byOwner.set(row.owner_id, playlists);
      }
      const playlist = playlists.get(row.playlist_id);
      if (playlist) shares.push({ id: row.id, ...playlist, owner: { id: row.owner_id, name: row.owner_name }, permission: row.can_edit ? "editor" : "viewer" });
    }
    return { shareOffset: offset, hasMore: rows.length > limit, shares };
  }
```

### Filtered track response

`server/src/library.ts`

```ts
async function getTrackPage(kind: "favorites" | "history" | "playlist", pid: string, offset: number, limit: number, q = "") {
  const lib = await load();
  const source = kind === "playlist" ? findPlaylist(lib, pid).tracks : lib[kind];
  const term = q.trim().toLocaleLowerCase();
  if (!term) return { tracks: source.slice(offset, offset + limit), total: source.length, offset, limit, hasMore: offset + limit < source.length };
  const tracks: Track[] = [];
  let total = 0;
  for (const track of source) {
    const text = `${track.title} ${track.artist} ${track.album ?? ""}`.toLocaleLowerCase();
    if (!text.includes(term)) continue;
    if (total >= offset && tracks.length < limit) tracks.push(track);
    total++;
  }
  return { tracks, total, offset, limit, hasMore: offset + tracks.length < total };
}
```

### SQLite index migration

`server/src/db.ts`

```ts
const performanceSchema = `
CREATE INDEX otps_cleanup_time ON otps(created_at);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE INDEX clients_session ON clients(session_hash);
CREATE INDEX import_runs_running ON import_runs(status) WHERE status='running';
INSERT INTO migrations(key,value) VALUES('query-performance-v1','1');`;
```

### Worker statement reuse

`server/src/db.ts`

```js
      const prepared = new Map();
      const execute = ({sql, params = [], mode = 'run'}) => {
        let statement = prepared.get(sql);
        if (statement) {
          prepared.delete(sql);
        } else {
          statement = db.prepare(sql);
          if (prepared.size === 128) prepared.delete(prepared.keys().next().value);
        }
        prepared.set(sql, statement);
        const value = statement[mode](...params);
        return mode === 'run' ? {changes: Number(value.changes), lastInsertRowid: Number(value.lastInsertRowid)} : value;
      };
```

### Focus and secondary controls

`web/src/styles.css`

```css
  .button-secondary {
    @apply inline-flex h-11 items-center justify-center rounded-full bg-surface-3 px-5 text-sm font-medium text-fg transition-colors disabled:cursor-default disabled:opacity-40;
  }
  @media (hover: hover) {
    .button-secondary:not(:disabled):hover {
      background: var(--surface-4);
    }
  }
```

The base focus rule in the same file uses the contrast-adjusted theme token.

```css
  :focus-visible {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
```

### Lightweight startup response

`server/src/librarySummary.ts`

```ts
export function summarizeLibrary(library: Library): LibrarySummary {
  return {
    playlists: library.playlists.map(describePlaylist),
    favorites: { ids: library.favorites.map(track => track.id), preview: library.favorites.slice(0, FAVORITES_PREVIEW_SIZE) },
    history: library.history.slice(0, 60),
  };
}
```
