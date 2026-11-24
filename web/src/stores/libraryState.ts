import { create } from "zustand";
import { describePlaylist, FAVORITES_PREVIEW_SIZE, summarizeLibrary, type LibrarySummary, type PlaylistSummary } from "../../../server/src/librarySummary.js";
import type { Messages } from "../i18n/en";
import type { ImportResult, MusikeApi } from "../lib/apiTypes";
import { OptimisticQueue } from "../lib/optimisticQueue";
import type { Library, Playlist, Track } from "../lib/types";

interface LibraryData {
  favorites: Track[];
  favoriteIds: ReadonlySet<string>;
  favoritesComplete: boolean;
  history: Track[];
  confirmedHistory: Track[];
  playlists: PlaylistSummary[];
  details: ReadonlyMap<string, Playlist>;
  indexRevision: number;
  snapshotRevision: number;
}
interface LibraryState extends LibraryData {
  status: "idle" | "loading" | "ready" | "error";
  load: () => Promise<void>;
  loadFavorites: () => Promise<Track[]>;
  loadPlaylist: (id: string) => Promise<Playlist>;
  reset: (offline?: Library) => void;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (t: Track) => Promise<void>;
  addFavorites: (tracks: Track[]) => Promise<void>;
  recordPlay: (t: Track) => void;
  createPlaylist: (name: string, tracks?: Track[]) => Promise<Playlist | null>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deleteTrack: (id: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (id: string, t: Track | Track[]) => Promise<void>;
  removeFromPlaylist: (id: string, trackId: string) => Promise<void>;
  importLibrary: (backup: unknown, mode: "merge" | "replace") => Promise<ImportResult>;
}

const emptyData = (): LibraryData => ({
  favorites: [], favoriteIds: new Set(), favoritesComplete: false, history: [], confirmedHistory: [],
  playlists: [], details: new Map(), indexRevision: 0, snapshotRevision: 0,
});
const identity = (data: LibraryData) => data;

function fromSummary(data: LibraryData, summary: LibrarySummary): LibraryData {
  return {
    favorites: summary.favorites.preview, favoriteIds: new Set(summary.favorites.ids), favoritesComplete: false,
    history: summary.history, confirmedHistory: summary.history, playlists: summary.playlists, details: new Map(),
    indexRevision: data.indexRevision + 1, snapshotRevision: data.snapshotRevision + 1,
  };
}

function favoriteList(data: LibraryData, tracks: Track[], ids: ReadonlySet<string> = new Set(tracks.map(t => t.id))): LibraryData {
  return { ...data, favorites: data.favoritesComplete ? tracks : tracks.slice(0, FAVORITES_PREVIEW_SIZE), favoriteIds: ids };
}

function cachePlaylist(data: LibraryData, playlist: Playlist): LibraryData {
  const details = new Map(data.details);
  details.delete(playlist.id);
  details.set(playlist.id, playlist);
  if (details.size > 4) details.delete(details.keys().next().value!);
  return { ...data, details };
}

function replacePlaylist(data: LibraryData, playlist: Playlist): LibraryData {
  const updated = { ...data, playlists: data.playlists.map(p => p.id === playlist.id ? describePlaylist(playlist) : p) };
  return data.details.has(playlist.id) ? cachePlaylist(updated, playlist) : updated;
}

function editCachedPlaylist(data: LibraryData, id: string, edit: (playlist: Playlist) => Playlist): LibraryData {
  const cached = data.details.get(id);
  if (!cached) return data;
  return replacePlaylist(data, edit(cached));
}

/** Scope requests and optimistic writes to the current account and online/offline lifecycle. */
export function createLibraryStore(api: MusikeApi, messages: () => Messages, toast: (message: string, tone?: "info" | "error") => void) {
  return create<LibraryState>((set, get) => {
    const empty = emptyData();
    let scope = new AbortController();
    const queue = (initial: LibraryData, signal: AbortSignal) => new OptimisticQueue(initial, data => { if (!signal.aborted) set(data); });
    let writes = queue(empty, scope.signal);
    let loading: Promise<void> | null = null;
    let loadingFavorites: Promise<Track[]> | null = null;
    const loadingPlaylists = new Map<string, Promise<Playlist>>();

    function run<R>(apply: (data: LibraryData) => LibraryData, request: (signal: AbortSignal) => Promise<R>,
      commit: (data: LibraryData, result: R) => LibraryData) {
      const signal = scope.signal;
      return writes.run(apply, async () => {
        signal.throwIfAborted();
        try {
          const result = await request(signal);
          signal.throwIfAborted();
          return result;
        } catch (error) {
          signal.throwIfAborted();
          throw error;
        }
      }, commit);
    }
    const report = (error: unknown) => { if ((error as Error).name !== "AbortError") toast((error as Error).message, "error"); };
    const durable = (data: LibraryData) => ({ ...data, snapshotRevision: data.snapshotRevision + 1 });

    return {
      ...empty,
      status: "idle",
      reset: (offline) => {
        scope.abort();
        scope = new AbortController();
        loading = null;
        loadingFavorites = null;
        loadingPlaylists.clear();
        const empty = emptyData();
        const data = offline ? {
          ...fromSummary(empty, summarizeLibrary(offline)), favorites: offline.favorites, favoritesComplete: true,
          details: new Map(offline.playlists.map(playlist => [playlist.id, playlist])),
        } : empty;
        writes = queue(data, scope.signal);
        set({ ...data, status: offline ? "ready" : "idle" });
      },
      load: () => {
        if (loading) return loading;
        const signal = scope.signal;
        if (get().status !== "ready") set({ status: "loading" });
        const request = run(identity, signal => api.librarySummary(signal), fromSummary).then(
          () => { if (!signal.aborted) set({ status: "ready" }); },
          () => { if (!signal.aborted && get().status !== "ready") set({ status: "error" }); },
        ).finally(() => { if (loading === request) loading = null; });
        loading = request;
        return request;
      },
      loadFavorites: () => {
        if (loadingFavorites) return loadingFavorites;
        const state = get();
        if (state.favoritesComplete && !loading) return Promise.resolve(state.favorites);
        const signal = scope.signal;
        const request = run(identity, signal => api.libraryFavorites(signal), (data, result) =>
          favoriteList({ ...data, favoritesComplete: true }, result.favorites))
          .then(() => { signal.throwIfAborted(); return get().favorites; })
          .finally(() => { if (loadingFavorites === request) loadingFavorites = null; });
        loadingFavorites = request;
        return request;
      },
      loadPlaylist: (id) => {
        const pending = loadingPlaylists.get(id);
        if (pending) return pending;
        const cached = get().details.get(id);
        if (cached && !loading) return Promise.resolve(cached);
        const signal = scope.signal;
        const request = run(identity, signal => api.playlist(id, signal),
          (data, playlist) => cachePlaylist(replacePlaylist(data, playlist), playlist))
          .then(playlist => { signal.throwIfAborted(); return get().details.get(id) ?? playlist; })
          .finally(() => { if (loadingPlaylists.get(id) === request) loadingPlaylists.delete(id); });
        loadingPlaylists.set(id, request);
        return request;
      },
      isFavorite: (id) => get().favoriteIds.has(id),
      toggleFavorite: async (track) => {
        const on = !get().isFavorite(track.id);
        const apply = (data: LibraryData) => {
          const ids = new Set(data.favoriteIds);
          const without = data.favorites.filter(t => t.id !== track.id);
          if (on) ids.add(track.id); else ids.delete(track.id);
          return favoriteList(data, on ? [track, ...without] : without, ids);
        };
        try {
          await run(apply, signal => on ? api.addFavorite(track, signal) : api.removeFavorite(track.id, signal),
            (data, result) => durable(favoriteList(data, result.favorites)));
          toast(on ? messages().toasts.addedFavorite : messages().toasts.removedFavorite);
        } catch (error) { report(error); }
      },
      addFavorites: async (tracks) => {
        const seen = new Set(get().favoriteIds);
        const fresh = tracks.filter(t => !seen.has(t.id) && !!seen.add(t.id)).slice(0, 500);
        if (!fresh.length) return toast(messages().toasts.allAlreadyFavorites);
        try {
          await run(data => {
            const ids = new Set(data.favoriteIds);
            const added = fresh.filter(track => !ids.has(track.id) && !!ids.add(track.id));
            return favoriteList(data, [...added, ...data.favorites], ids);
          }, signal => api.addFavorites(fresh, signal), (data, result) => durable(favoriteList(data, result.favorites)));
          toast(fresh.length === 1 ? messages().toasts.addedFavorite : messages().toasts.addedFavorites(fresh.length));
        } catch (error) { report(error); }
      },
      recordPlay: (track) => {
        void run(data => ({ ...data, history: [track, ...data.history.filter(t => t.id !== track.id)].slice(0, 60) }),
          signal => api.pushHistory(track, signal), (data, result) => ({ ...data, history: result.history, confirmedHistory: result.history })).catch(() => {});
      },
      createPlaylist: async (name, tracks = []) => {
        try {
          const p = await run(identity, signal => api.createPlaylist(name, tracks, signal),
            (data, p) => durable(cachePlaylist({ ...data, playlists: [describePlaylist(p), ...data.playlists] }, p)));
          toast(messages().toasts.playlistCreated(p.name));
          return p;
        } catch (error) { report(error); return null; }
      },
      renamePlaylist: async (id, name) => {
        try {
          await run(data => {
            const updated = editCachedPlaylist(data, id, p => ({ ...p, name }));
            return { ...updated, playlists: updated.playlists.map(p => p.id === id ? { ...p, name } : p) };
          }, signal => api.renamePlaylist(id, name, signal), (data, p) => durable(replacePlaylist(data, p)));
        } catch (error) { report(error); }
      },
      deleteTrack: async (id) => {
        const remove = (data: LibraryData) => {
          let next = favoriteList(data, data.favorites.filter(t => t.id !== id), new Set([...data.favoriteIds].filter(favorite => favorite !== id)));
          for (const pid of data.details.keys()) next = editCachedPlaylist(next, pid, p => ({ ...p, tracks: p.tracks.filter(t => t.id !== id) }));
          return { ...next, history: data.history.filter(t => t.id !== id) };
        };
        await run(remove, signal => api.deleteTrack(id, signal), (data, result) => {
          const next = fromSummary(data, summarizeLibrary(result));
          const details = new Map(result.playlists.filter(p => data.details.has(p.id)).map(p => [p.id, p]));
          return favoriteList({ ...next, details, favoritesComplete: data.favoritesComplete }, result.favorites);
        });
      },
      deletePlaylist: async (id) => {
        const remove = (data: LibraryData) => {
          const details = new Map(data.details);
          details.delete(id);
          return { ...data, details, playlists: data.playlists.filter(p => p.id !== id) };
        };
        try {
          await run(remove, signal => api.deletePlaylist(id, signal), (data) => durable(remove(data)));
          toast(messages().toasts.playlistDeleted);
        } catch (error) { report(error); }
      },
      addToPlaylist: async (id, tracks) => {
        try {
          let before = 0;
          const p = await run(identity, signal => {
            before = get().playlists.find(p => p.id === id)?.trackCount ?? 0;
            return api.addToPlaylist(id, tracks, signal);
          }, (data, p) => durable(replacePlaylist(data, p)));
          const added = Math.max(0, p.tracks.length - before);
          const t = messages();
          if (!Array.isArray(tracks) || added === 1) toast(t.toasts.addedTo(p.name));
          else toast(added ? t.toasts.addedManyTo(added, p.name) : t.toasts.allAlreadyIn(p.name));
        } catch (error) { report(error); }
      },
      removeFromPlaylist: async (id, trackId) => {
        try {
          await run(data => editCachedPlaylist(data, id, p => ({ ...p, tracks: p.tracks.filter(t => t.id !== trackId) })),
            signal => api.removeFromPlaylist(id, trackId, signal), (data, p) => durable(replacePlaylist(data, p)));
        } catch (error) { report(error); }
      },
      importLibrary: (backup, mode) => {
        const signal = scope.signal;
        return run(identity, async signal => {
          const result = await api.importLibrary(backup, mode, signal);
          signal.throwIfAborted();
          return { result, summary: await api.librarySummary(signal) };
        }, (data, result) => fromSummary(data, result.summary)).then(({ result }) => {
          signal.throwIfAborted();
          set({ status: "ready" });
          return result;
        });
      },
    };
  });
}
