import { useSession } from "../stores/session";
import { useOffline } from "../stores/offline";
import { OfflinePlaylistButton } from "../components/OfflineStorage";
import { DotsThreeIcon, MagnifyingGlassIcon, PauseIcon, PencilSimpleIcon, PlayIcon, ShuffleIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Cover, type CoverKind } from "../components/Cover";
import { NamePlaylistDialog } from "../components/Dialogs";
import { IconButton, PlayDisc } from "../components/IconButton";
import { Modal } from "../components/Modal";
import { EmptyState, PageHeader } from "../components/Page";
import { TrackList, TrackListSkeleton } from "../components/TrackList";
import { useT } from "../i18n";
import { shuffled } from "../lib/format";
import { paths } from "../lib/routes";
import { trackIds } from "../lib/trackIds";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";

interface Props {
  kind: CoverKind;
  downloaded?: boolean;
}
const EMPTY_TRACKS: Track[] = [];

/** Playlist, Favorites and History share one layout. */
export default function Collection({ kind, downloaded = false }: Props) {
  const { id } = useParams();
  const offline = useSession(s => !!s.offline);
  const [params] = useSearchParams(); const downloads = downloaded || offline || params.get("downloads") === "1";
  const entries = useOffline(s => downloads ? s.summary?.entries : undefined);
  const available = useMemo(() => new Set(entries?.map(e => e.id)), [entries]);
  const navigate = useNavigate();
  const summary = useLibrary(s => kind === "playlist" ? s.playlists.find(p => p.id === id) : undefined);
  const playlist = useLibrary(s => kind === "playlist" && id ? s.details.get(id) : undefined);
  const favoritesComplete = useLibrary(s => s.favoritesComplete);
  const indexRevision = useLibrary(s => s.indexRevision);
  const load = useLibrary(s => s.load);
  const loadFavorites = useLibrary(s => s.loadFavorites);
  const loadPlaylist = useLibrary(s => s.loadPlaylist);
  const collectionTracks = useLibrary((s) => kind === "favorites" ? s.favorites : kind === "history" ? s.history : playlist?.tracks ?? EMPTY_TRACKS);
  const downloadedTracks = useMemo(() => entries?.map(entry => entry.track) ?? EMPTY_TRACKS, [entries]);
  const tracks = downloaded ? downloadedTracks : collectionTracks;
  const libraryStatus = useLibrary((s) => s.status);
  const renamePlaylist = useLibrary((s) => s.renamePlaylist);
  const deletePlaylist = useLibrary((s) => s.deletePlaylist);
  const playList = usePlayer((s) => s.playList);
  const toggle = usePlayer((s) => s.toggle);
  const queue = usePlayer((s) => s.queue);
  const active = usePlayer(s => s.status === "playing" || s.status === "loading");
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const t = useT();
  const [failed, setFailed] = useState<string>();
  const [retry, setRetry] = useState(0);
  const needsTracks = !downloaded && (kind === "playlist" ? !!summary && !playlist : kind === "favorites" && !favoritesComplete);
  const detailKey = JSON.stringify([kind, id, indexRevision, retry, offline]);
  useEffect(() => {
    if (offline || !needsTracks || libraryStatus !== "ready") return;
    let active = true;
    const request = kind === "playlist" && id ? loadPlaylist(id) : loadFavorites();
    void request.catch(() => { if (active) setFailed(detailKey); });
    return () => { active = false; };
  }, [detailKey, needsTracks, libraryStatus, offline, kind, id, loadFavorites, loadPlaylist]);

  const name = downloaded ? t.offline.allDownloaded : kind === "favorites" ? t.nav.favorites : kind === "history" ? t.nav.recentlyPlayed : summary?.name ?? "";
  const label =
    kind === "playlist" ? t.collection.labelPlaylist : kind === "favorites" ? t.collection.labelFavorites : t.collection.labelHistory;
  const playable = useMemo(() => downloads ? tracks.filter(track => available.has(track.id)) : tracks, [tracks, downloads, available]);
  const isThisPlaying = useMemo(() => {
    if (!playable.length || queue.length !== playable.length) return false;
    const ids = trackIds(playable);
    return queue.every(track => ids.has(track.id));
  }, [playable, queue]);
  const favoritesPin = useMemo(() => ({ id: "favorites", name, tracks, createdAt: 0, updatedAt: 0 }), [name, tracks]);
  const start = (items = playable) => { if (downloads) { usePlayer.getState().setPreferVideo(false); usePlayer.getState().setAutoRadio(false); } playList(items, 0); };
  const total = useMemo(() => tracks.reduce((sum, track) => sum + (track.duration || 0), 0), [tracks]);

  if (!downloaded && (libraryStatus === "error" || (needsTracks && failed === detailKey))) {
    return <><PageHeader title={name} /><button type="button" className="button-secondary mx-4 mt-3"
      onClick={() => { if (libraryStatus === "error") void load(); else setRetry(retry + 1); }}>{t.common.retry}</button></>;
  }
  if (!downloaded && (libraryStatus !== "ready" || needsTracks)) {
    return <><PageHeader title={name} /><TrackListSkeleton /></>;
  }

  if (kind === "playlist" && !summary) {
    return (
      <>
        <PageHeader />
        <EmptyState
          icon={<MagnifyingGlassIcon size={28} />}
          title={t.collection.notFoundTitle}
          body={t.collection.notFoundBody}
          action={
            <Link to={paths.library} className="mt-2 h-11 rounded-full bg-surface-3 px-6 text-sm leading-[44px] font-medium">
              {t.collection.goToLibrary}
            </Link>
          }
        />
      </>
    );
  }

  const playing = isThisPlaying && active;

  return (
    <div className="pb-8">
      <PageHeader title={name} mobileOnly />

      <div className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-20 h-72 bg-linear-to-b from-accent-soft to-transparent" />
        <div className="relative flex flex-col items-center gap-5 px-4 pt-2 pb-6 md:flex-row md:items-end md:gap-6 md:px-6 md:pt-10">
          <Cover
            kind={kind}
            tracks={tracks}
            iconSize={64}
            className="size-44 shrink-0 rounded-[18px] shadow-[0_24px_60px_rgb(0_0_0/0.4)] md:size-52"
          />
          <div className="flex min-w-0 flex-col items-center gap-2 text-center md:items-start md:text-left">
            <span className="hidden text-xs font-medium text-fg-2 md:block">{label}</span>
            {playlist?.origin && <span className="text-xs text-fg-2">{playlist.origin.provider === "youtube" ? t.collaboration.youtubePlaylist : playlist.origin.kind === "album" ? t.features.albumOrigin : t.features.playlistOrigin}</span>}
            <h1 className="max-w-full text-[28px] leading-[1.1] font-bold tracking-tight break-words md:text-5xl lg:text-6xl">{name}</h1>
            <p className="font-mono text-[13px] text-fg-2">
              {t.common.tracks(tracks.length)}
              {total > 0 && <> · {t.time.total(total)}</>}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-4 md:px-6">
        <PlayDisc
          label={playing ? t.common.pause : t.common.playX(name)}
          px={56}
          disabled={!playable.length}
          onClick={() => (isThisPlaying ? toggle() : start())}
        >
          {playing ? <PauseIcon size={24} weight="fill" /> : <PlayIcon size={24} weight="fill" />}
        </PlayDisc>
        <IconButton
          label={t.collection.shuffle}
          size="lg"
          disabled={!playable.length}
          onClick={() => {
            const order = shuffled(playable);
            start(order);
          }}
        >
          <ShuffleIcon size={24} />
        </IconButton>
        {kind === "playlist" && !offline && (
          <IconButton label={t.collection.more} size="lg" onClick={() => setMoreOpen(true)}>
            <DotsThreeIcon size={26} weight="bold" />
          </IconButton>
        )}
      </div>

      {kind === "favorites" && !offline && !downloaded && <section className="px-4 pb-4 md:px-6"><OfflinePlaylistButton playlist={favoritesPin} /></section>}
      {playlist && !offline && <section className="px-4 pb-4 md:px-6"><OfflinePlaylistButton playlist={playlist} /></section>}
      <div className="px-2 md:px-3">
        {tracks.length > 0 ? (
          <TrackList downloads={downloads} tracks={tracks} playlistId={playlist?.id} listKey={downloaded ? "downloaded-audio" : `${kind}:${id ?? ""}`} showAlbum />
        ) : (
          <EmptyState
            icon={<MagnifyingGlassIcon size={28} />}
            title={downloaded ? t.offline.empty : kind === "history" ? t.collection.emptyHistory : t.collection.empty}
            body={
              downloaded ? t.offline.notice : kind === "favorites"
                ? t.collection.emptyFavoritesBody
                : kind === "history"
                  ? t.collection.emptyHistoryBody
                  : t.collection.emptyPlaylistBody
            }
            action={!offline ?
              <Link to={paths.search} className="mt-2 h-11 rounded-full bg-accent px-6 text-sm leading-[44px] font-semibold text-accent-ink">
                {t.common.searchMusic}
              </Link> : undefined
            }
          />
        )}
      </div>

      {playlist && (
        <>
          <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title={playlist.name}>
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setRenaming(true);
                }}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-surface-3"
              >
                <PencilSimpleIcon size={18} className="text-fg-2" /> {t.collection.rename}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  setConfirmDelete(true);
                }}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-left text-danger hover:bg-surface-3"
              >
                <TrashIcon size={18} /> {t.collection.deletePlaylist}
              </button>
            </div>
          </Modal>

          <NamePlaylistDialog
            open={renaming}
            initial={playlist.name}
            title={t.collection.renameTitle}
            action={t.collection.save}
            onClose={() => setRenaming(false)}
            onSubmit={(n) => {
              void renamePlaylist(playlist.id, n);
              setRenaming(false);
            }}
          />

          <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t.collection.deleteTitle}>
            <p className="text-sm text-fg-2">
              {t.collection.deleteBody(playlist.name, playlist.tracks.length)}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg">
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  void deletePlaylist(playlist.id);
                  navigate(paths.library);
                }}
                className="h-11 rounded-full bg-danger px-6 text-sm font-semibold text-white"
              >
                {t.collection.delete}
              </button>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
