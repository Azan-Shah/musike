import { summarizeLibrary } from "./librarySummary.js";
import { msg } from "./i18n.js";
import { HttpError, VIDEO_ID, type Library, type Playlist, type Track, type Origin } from "./types.js";

// Storage-independent library operations; persistence is supplied by the server.

const HISTORY_LIMIT = 60;

/** Where the library is kept: a server file or an authenticated owner-scoped database row. */
export interface LibraryStorage {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function sanitizeOrigin(input: unknown): Origin | undefined {
  const o = (input ?? {}) as Partial<Origin>;
  if (!["youtube-music", "youtube"].includes(o.provider ?? "") || typeof o.sourceId !== "string" || o.sourceId.length > 600 || !["playlist", "album", "like", "history"].includes(o.kind ?? "")) return undefined;
  return { provider: o.provider!, sourceId: o.sourceId, kind: o.kind! };
}
export function sanitizeTrack(input: unknown): Track {
  const t = (input ?? {}) as Record<string, unknown>;
  const id = str(t.id, 11);
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidTrack"));
  const url = (v: unknown) => {
    const s = str(v, 500);
    return /^https:\/\//.test(s) ? s : "";
  };
  return {
    id,
    origin: sanitizeOrigin(t.origin),
    title: str(t.title, 300) || "Untitled",
    artist: str(t.artist, 300),
    album: str(t.album, 300) || undefined,
    duration: typeof t.duration === "number" && Number.isFinite(t.duration) ? Math.max(0, Math.round(t.duration)) : 0,
    thumb: url(t.thumb),
    art: url(t.art),
    kind: t.kind === "video" ? "video" : "song",
  };
}

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  favoritesAdded: number;
  skipped?: number;
}

export function createLibrary(initialStorage?: LibraryStorage) {
let storage: LibraryStorage | null = initialStorage ?? null;
let state: Library | null = null;
let loading: Promise<Library> | null = null;
let writeChain: Promise<void> = Promise.resolve();
type Edit = { apply: (library: Library) => Library; complete: () => void; reject: (error: unknown) => void };
let pending: Edit[] = [];
let readySummary: { library: Library; result: ReturnType<typeof summarizeLibrary> } | undefined;
const membership = new WeakMap<Track[], Set<string>>();
let busy = 0;
let touched = Date.now();

/** Set once at startup, before any request. */
function useLibraryStorage(s: LibraryStorage) {
  storage = s;
  state = null;
  loading = null;
  writeChain = Promise.resolve();
  pending = [];
  readySummary = undefined;
}

const randomUUID = () => globalThis.crypto.randomUUID();

async function load(): Promise<Library> {
  touched = Date.now();
  if (state) return state;
  if (!storage) throw new Error("Library storage not configured");
  // All cold-start requests must share the same state object, including mutations.
  loading ??= storage.read().then((json) => {
    state = json ? (JSON.parse(json) as Library) : { favorites: [], playlists: [], history: [] };
    return state;
  }).finally(() => { loading = null; });
  return loading;
}

/** Publish only after the entire same-turn batch reaches storage. */
function edit<T>(apply: (lib: Library) => [Library, T]): Promise<T> {
  busy++;
  return new Promise<T>((resolve, reject) => {
    let result: T;
    pending.push({
      apply(library) { const [next, value] = apply(library); result = value; return next; },
      complete: () => resolve(result),
      reject,
    });
    if (pending.length !== 1) return;
    queueMicrotask(() => {
      const batch = pending;
      pending = [];
      writeChain = writeChain.then(async () => {
        try {
          const current = await load();
          let next = current;
          const valid: Edit[] = [];
          for (const operation of batch) {
            try { next = operation.apply(next); valid.push(operation); }
            catch (error) { operation.reject(error); }
          }
          if (next !== current) {
            await storage!.write(JSON.stringify(next));
            state = next;
            readySummary = undefined;
          }
          for (const operation of valid) operation.complete();
        } catch (error) {
          for (const operation of batch) operation.reject(error);
        }
      });
    });
  }).finally(() => { busy--; touched = Date.now(); });
}

function evictIdle(before: number) {
  if (busy || loading || touched >= before) return;
  state = null;
  readySummary = undefined;
}

function findPlaylist(lib: Library, pid: string): Playlist {
  const p = lib.playlists.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, msg("playlistNotFound"));
  return p;
}

async function getLibrary(): Promise<Library> {
  return load();
}

async function getSummary() {
  const library = await load();
  if (readySummary?.library !== library) readySummary = { library, result: summarizeLibrary(library) };
  return readySummary.result;
}

async function getFavorites() {
  return (await load()).favorites;
}

async function getPlaylist(pid: string) {
  return findPlaylist(await load(), pid);
}

async function playlistMembership(ids: string[]) {
  const wanted = [...new Set(ids)];
  const matches: string[] = [];
  if (!wanted.length) return matches;
  for (const playlist of (await load()).playlists) {
    if (playlist.tracks.length < wanted.length) continue;
    let indexed = membership.get(playlist.tracks);
    if (!indexed) {
      indexed = new Set(playlist.tracks.map(track => track.id));
      membership.set(playlist.tracks, indexed);
    }
    if (wanted.every(id => indexed.has(id))) matches.push(playlist.id);
  }
  return matches;
}

/** Bounded response for callers browsing a large local collection. Full export remains getLibrary(). */
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

function addFavorite(track: Track): Promise<Track[]> {
  return edit(lib => {
    const favorites = [track, ...lib.favorites.filter(t => t.id !== track.id)];
    return [{ ...lib, favorites }, favorites];
  });
}

function appendTracks(current: Track[], incoming: Track[]) {
  const seen = new Set(current.map(track => track.id));
  const added = incoming.filter(track => !seen.has(track.id) && !!seen.add(track.id));
  return added;
}

function addFavorites(tracks: Track[]): Promise<Track[]> {
  return edit(lib => {
    const added = appendTracks(lib.favorites, tracks);
    if (!added.length) return [lib, lib.favorites];
    const favorites = [...added, ...lib.favorites];
    return [{ ...lib, favorites }, favorites];
  });
}

function removeFavorite(id: string): Promise<Track[]> {
  return edit(lib => {
    const favorites = lib.favorites.filter(t => t.id !== id);
    return [{ ...lib, favorites }, favorites];
  });
}

function pushHistory(track: Track): Promise<Track[]> {
  return edit(lib => {
    const history = [track, ...lib.history.filter(t => t.id !== track.id)].slice(0, HISTORY_LIMIT);
    return [{ ...lib, history }, history];
  });
}

function playlistName(name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(400, msg("playlistNameRequired"));
  return clean;
}

function createPlaylist(name: string, tracks: Track[] = [], origin?: Origin): Promise<Playlist> {
  return edit(lib => {
    const now = Date.now();
    const playlist: Playlist = { id: randomUUID(), name: playlistName(name), createdAt: now, updatedAt: now,
      tracks: appendTracks([], tracks), ...(origin ? { origin } : {}) };
    return [{ ...lib, playlists: [playlist, ...lib.playlists] }, playlist];
  });
}

function revise(playlist: Playlist, changes: Partial<Pick<Playlist, "name" | "tracks">>) {
  return { ...playlist, ...changes, updatedAt: Math.max(Date.now(), playlist.updatedAt + 1) };
}

function changePlaylist(pid: string, change: (p: Playlist) => Playlist): Promise<Playlist> {
  return edit(lib => {
    const previous = findPlaylist(lib, pid);
    const next = change(previous);
    if (next === previous) return [lib, previous];
    return [{ ...lib, playlists: lib.playlists.map(p => p === previous ? next : p) }, next];
  });
}

function renamePlaylist(pid: string, name: string): Promise<Playlist> {
  return changePlaylist(pid, p => revise(p, { name: playlistName(name) }));
}

function deletePlaylist(pid: string): Promise<void> {
  return edit(lib => {
    findPlaylist(lib, pid);
    return [{ ...lib, playlists: lib.playlists.filter(p => p.id !== pid) }, undefined];
  });
}

function addToPlaylist(pid: string, tracks: Track | Track[]): Promise<Playlist> {
  return changePlaylist(pid, p => {
    const added = appendTracks(p.tracks, Array.isArray(tracks) ? tracks : [tracks]);
    return added.length ? revise(p, { tracks: [...p.tracks, ...added] }) : p;
  });
}

function deleteTrack(id: string): Promise<Library> {
  return edit(lib => {
    const next = {
      favorites: lib.favorites.filter(t => t.id !== id),
      history: lib.history.filter(t => t.id !== id),
      playlists: lib.playlists.map(p => {
        if (!p.tracks.some(track => track.id === id)) return p;
        return revise(p, { tracks: p.tracks.filter(track => track.id !== id) });
      }),
    };
    return [next, next];
  });
}

function removeFromPlaylist(pid: string, trackId: string): Promise<Playlist> {
  return changePlaylist(pid, p => revise(p, { tracks: p.tracks.filter(t => t.id !== trackId) }));
}

/** Optimistic revision check for authorized shared editing. */
function editPlaylist(pid: string, revision: number, name: string, tracks: Track[]): Promise<Playlist> {
  return changePlaylist(pid, p => {
    if (p.updatedAt !== revision) throw new HttpError(409, "Playlist changed; reload before editing");
    return revise(p, { name, tracks: appendTracks([], tracks) });
  });
}

/** Version 1 exports round-trip within the HTTP backup body limit. */
function cleanLibrary(input: unknown, replace: boolean) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, msg("notBackup"));
  const lib = input as Record<string, unknown>;
  for (const key of ["favorites", "playlists", "history"]) {
    if ((replace || lib[key] !== undefined) && !Array.isArray(lib[key])) throw new HttpError(400, msg("notBackup"));
  }
  let skipped = 0;
  function cleanTracks(input: unknown, limit = Infinity): Track[] {
    const seen = new Set<string>();
    const tracks: Track[] = [];
    if (!Array.isArray(input)) return tracks;
    for (const raw of input) {
      try {
        if (typeof raw?.id !== "string" || !VIDEO_ID.test(raw.id)) throw new Error("Invalid track ID");
        const t = sanitizeTrack(raw);
        if (!seen.has(t.id) && tracks.length < limit) { seen.add(t.id); tracks.push(t); }
        else skipped++;
      } catch { skipped++; }
    }
    return tracks;
  }

  const usedIds = new Set<string>();
  const playlists = (Array.isArray(lib.playlists) ? lib.playlists : []).flatMap((raw): Playlist[] => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const name = str(p.name, 80).trim();
    if (!name || !Array.isArray(p.tracks)) { skipped++; return []; }
    const now = Date.now();
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : now;
    let id = str(p.id, 64);
    if (!/^[\w-]{8,64}$/.test(id) || (replace && usedIds.has(id))) id = randomUUID();
    usedIds.add(id);
    return [{ id, name, origin: sanitizeOrigin(p.origin), createdAt: num(p.createdAt), updatedAt: num(p.updatedAt), tracks: cleanTracks(p.tracks) }];
  });
  const library = { favorites: cleanTracks(lib.favorites), playlists, history: cleanTracks(lib.history, HISTORY_LIMIT) };
  if (replace && skipped && !library.favorites.length && !library.playlists.length && !library.history.length) throw new HttpError(400, msg("notBackup"));
  return { library, skipped };
}

async function importLibrary(input: unknown, mode: "merge" | "replace"): Promise<ImportResult> {
  const { library: incoming, skipped } = cleanLibrary(input, mode === "replace");
  return edit(lib => {
    const result: ImportResult = { playlistsAdded: 0, playlistsMerged: 0, tracksAdded: 0, favoritesAdded: 0 };
    if (skipped) result.skipped = skipped;
    if (mode === "replace") {
      result.playlistsAdded = incoming.playlists.length;
      result.favoritesAdded = incoming.favorites.length;
      result.tracksAdded = incoming.playlists.reduce((n, p) => n + p.tracks.length, 0);
      return [incoming, result];
    }

    const playlists = [...lib.playlists];
    const byId = new Map(playlists.map((p, i) => [p.id, i]));
    const byName = new Map<string, number>();
    playlists.forEach((p, i) => {
      const key = p.name.toLocaleLowerCase("pt-BR");
      if (!byName.has(key)) byName.set(key, i);
    });
    for (const p of incoming.playlists) {
      const key = p.name.toLocaleLowerCase("pt-BR");
      const index = byId.get(p.id) ?? byName.get(key);
      if (index !== undefined) {
        const match = playlists[index]!;
        const added = appendTracks(match.tracks, p.tracks);
        if (!added.length) continue;
        playlists[index] = revise(match, { tracks: [...match.tracks, ...added] });
        result.tracksAdded += added.length;
        result.playlistsMerged++;
      } else {
        byId.set(p.id, playlists.length);
        byName.set(key, playlists.length);
        playlists.push(p);
        result.tracksAdded += p.tracks.length;
        result.playlistsAdded++;
      }
    }

    const favorites = appendTracks(lib.favorites, incoming.favorites);
    result.favoritesAdded = favorites.length;
    const history = [...lib.history, ...appendTracks(lib.history, incoming.history)].slice(0, HISTORY_LIMIT);
    return [{ favorites: [...lib.favorites, ...favorites], playlists, history }, result];
  });
}

return { deleteTrack, editPlaylist, evictIdle, useLibraryStorage, getLibrary, getSummary, getFavorites, getPlaylist, playlistMembership, getTrackPage, addFavorite, addFavorites, removeFavorite, pushHistory, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, importLibrary };
}

const sharedLibrary = createLibrary();


export const useLibraryStorage = sharedLibrary.useLibraryStorage;
export const getLibrary = sharedLibrary.getLibrary;
export const getSummary = sharedLibrary.getSummary;
export const getFavorites = sharedLibrary.getFavorites;
export const getPlaylist = sharedLibrary.getPlaylist;
export const playlistMembership = sharedLibrary.playlistMembership;
export const getTrackPage = sharedLibrary.getTrackPage;
export const addFavorite = sharedLibrary.addFavorite;
export const addFavorites = sharedLibrary.addFavorites;
export const removeFavorite = sharedLibrary.removeFavorite;
export const pushHistory = sharedLibrary.pushHistory;
export const createPlaylist = sharedLibrary.createPlaylist;
export const renamePlaylist = sharedLibrary.renamePlaylist;
export const deletePlaylist = sharedLibrary.deletePlaylist;
export const addToPlaylist = sharedLibrary.addToPlaylist;
export const removeFromPlaylist = sharedLibrary.removeFromPlaylist;
export const importLibrary = sharedLibrary.importLibrary;

export const deleteTrack = sharedLibrary.deleteTrack;
