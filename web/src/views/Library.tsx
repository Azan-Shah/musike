import { useOffline } from "../stores/offline";
import { OfflineStorage } from "../components/OfflineStorage";
import { PlaylistImportDialog } from "../components/PlaylistImportDialog";
import { IncomingShares } from "../components/IncomingShares";
import { ListPager } from "../components/ListPager";
import { useListPage } from "../hooks/useListPage";
import { useSession } from "../stores/session";
import { PlusIcon } from "@phosphor-icons/react";
import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Cover, type CoverKind } from "../components/Cover";
import { NamePlaylistDialog } from "../components/Dialogs";
import { PageHeader } from "../components/Page";
import { useT } from "../i18n";
import { paths } from "../lib/routes";
import type { CoverArtwork } from "../../../server/src/librarySummary.js";
import { api } from "../lib/api";
import type { Library as FullLibrary, Track } from "../lib/types";
import { useLibrary } from "../stores/library";

const Entry = memo(function Entry({ to, name, kind, tracks, sub }: { to: string; name: string; kind: CoverKind; tracks: CoverArtwork[]; sub: string }) {
  return (
    <li>
      <Link
        to={to}
        className="group flex items-center gap-3 rounded-tile p-2 transition-colors hover:bg-surface-2 md:flex-col md:items-stretch md:gap-3 md:p-3"
      >
        <Cover
          kind={kind}
          tracks={tracks}
          iconSize={26}
          className="size-16 shrink-0 rounded-art md:aspect-square md:size-auto md:w-full md:rounded-tile md:shadow-[0_12px_32px_rgb(0_0_0/0.3)]"
        />
        <span className="min-w-0">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-sm text-fg-2">{sub}</span>
        </span>
      </Link>
    </li>
  );
});
const EMPTY_TRACKS: Track[] = [];

export default function Library({ downloads = false }: { downloads?: boolean }) {
  const offline = useSession(s => !!s.offline);
  const user = useSession(s => s.user?.id);
  const local = downloads || offline;
  const entries = useOffline(s => local ? s.summary?.entries : undefined);
  const available = useMemo(() => new Set(entries?.map(e => e.id)), [entries]);
  const downloaded = useMemo(() => entries?.map(entry => entry.track) ?? EMPTY_TRACKS, [entries]);
  const [importing, setImporting] = useState(false);
  const favorites = useLibrary(s => s.favorites);
  const playlists = useLibrary(s => s.playlists);
  const history = useLibrary(s => s.history);
  const favoriteCount = useLibrary(s => s.favoriteIds.size);
  const status = useLibrary(s => s.status);
  const revision = useLibrary(s => s.snapshotRevision);
  const offlineDetails = useLibrary(s => offline ? s.details : undefined);
  const load = useLibrary(s => s.load);
  const [downloadSnapshot, setDownloadSnapshot] = useState<{ owner: string; library: FullLibrary }>();
  const downloadLibrary = downloadSnapshot && downloadSnapshot.owner === user ? downloadSnapshot.library : undefined;
  const [downloadError, setDownloadError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!downloads || offline || !user || status !== "ready") return;
    const request = new AbortController();
    setDownloadError(false);
    void api.library(request.signal).then(
      data => { if (!request.signal.aborted) setDownloadSnapshot({ owner: user, library: data }); },
      () => { if (!request.signal.aborted) setDownloadError(true); },
    );
    return () => request.abort();
  }, [downloads, offline, user, revision, retry, status]);
  const downloadDetails = useMemo(() => new Map(downloadLibrary?.playlists.map(p => [p.id, p])), [downloadLibrary]);
  const createPlaylist = useLibrary(s => s.createPlaylist);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const term = useDeferredValue(query.trim().toLocaleLowerCase());
  const filtered = useMemo(() => term ? playlists.filter(p => p.name.toLocaleLowerCase().includes(term)) : playlists, [playlists, term]);
  const page = useListPage(filtered, JSON.stringify(["library", user, local, term]), 36);
  const navigate = useNavigate();
  const t = useT();
  const target = (path: string) => downloads && !offline ? `${path}?downloads=1` : path;
  const counts = (total: number, tracks?: Track[]) => local && tracks
    ? t.offline.downloadedCount(tracks.reduce((n, track) => n + Number(available.has(track.id)), 0), total)
    : t.common.tracks(total);

  return (
    <div className="pb-8">
      <PageHeader
        title={t.nav.library}
        actions={
          <>
          {!offline && !downloads && <>
          {user && <button type="button" className="button-secondary text-xs" onClick={() => setImporting(true)}>{t.offline.importShort}</button>}
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex h-10 items-center gap-1.5 rounded-full bg-accent pr-4 pl-3 text-sm font-semibold text-accent-ink transition-transform active:scale-[0.97]"
          >
            <PlusIcon size={18} weight="bold" /> <span className="hidden sm:inline">{t.nav.newPlaylist}</span>
            <span className="sm:hidden">{t.library.newShort}</span>
          </button>
          </>}
          </>
        }
      />

      {user && <section className="px-4 pt-3 md:px-6">{!local && <Link className="button-secondary" to={paths.offline}>{t.offline.open}</Link>}<OfflineStorage /></section>}
      {status === "error" && <button type="button" className="button-secondary mx-4 mt-3" onClick={() => void load()}>{t.common.retry}</button>}
      {downloads && !offline && user && !downloadLibrary && status === "ready" &&
        (downloadError
          ? <button type="button" className="button-secondary mx-4 mt-3" onClick={() => setRetry(retry + 1)}>{t.common.retry}</button>
          : <p role="status" className="px-4 pt-3 text-sm text-fg-2">{t.common.loading}</p>)}
      {playlists.length > 0 && <div className="px-4 pt-3 md:px-6">
        <input type="search" aria-label={t.library.filterPlaylists} placeholder={t.library.filterPlaylists}
          className="h-11 w-full max-w-sm rounded-full bg-surface-2 px-4 text-sm ring-1 ring-line-strong"
          value={query} maxLength={200} onChange={e => setQuery(e.target.value)} />
      </div>}
      <ul className="grid grid-cols-1 gap-1 px-2 pt-2 md:grid-cols-3 md:gap-2 md:px-4 lg:grid-cols-4 2xl:grid-cols-6">
        {local && <Entry to={`${paths.offline}?view=tracks`} name={t.offline.allDownloaded} kind="history" tracks={downloaded} sub={t.common.tracks(downloaded.length)} />}
        <Entry to={target(paths.favorites)} name={t.nav.favorites} kind="favorites" tracks={favorites} sub={counts(favoriteCount, offline ? favorites : downloadLibrary?.favorites)} />
        <Entry to={target(paths.history)} name={t.nav.recentlyPlayed} kind="history" tracks={history} sub={counts(history.length, history)} />
        {page.items.map((p) => (
          <Entry
            key={p.id}
            to={target(paths.playlist(p.id))}
            name={p.name}
            kind="playlist"
            tracks={p.cover}
            sub={`${local ? counts(p.trackCount, (offline ? offlineDetails : downloadDetails)?.get(p.id)?.tracks) : t.library.playlistSub(p.trackCount)}${p.origin ? ` · ${p.origin.provider === "youtube" ? t.collaboration.youtubePlaylist : p.origin.kind === "album" ? t.features.albumOrigin : t.features.playlistOrigin}` : ""}`}
          />
        ))}
      </ul>
      <ListPager {...page} total={filtered.length} />
      {term && playlists.length > 0 && filtered.length === 0 &&
        <p role="status" className="px-4 pt-6 text-sm text-fg-2 md:px-6">{t.library.noMatchingPlaylists}</p>}

      {status === "ready" && playlists.length === 0 && (
        <p className="px-4 pt-6 text-sm text-fg-2 md:px-6">
          {t.library.noPlaylists}
        </p>
      )}

      {user && <PlaylistImportDialog open={importing} onClose={() => setImporting(false)} />}
      {user && !local && <IncomingShares key={user} />}
      <NamePlaylistDialog
        open={creating}
        title={t.nav.newPlaylist}
        action={t.library.create}
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          const p = await createPlaylist(name);
          setCreating(false);
          if (p) navigate(paths.playlist(p.id));
        }}
      />
    </div>
  );
}
