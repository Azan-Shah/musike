import type { LibrarySummary } from "../../../server/src/librarySummary.js";
import { beginPlaybackTrace, playbackTrace, recordPlayback, responseFailure, configurePlaybackDiagnostics, type FailureKind } from "./playbackDiagnostics";
import { useSession } from "../stores/session";
import { getLang, getT } from "../i18n";
import {
  ApiError,
  type Channel,
  type ErrorCode,
  type ImportResult,
  type MusikeApi,
  type Prepared,
  type SystemInfo,
  type SystemJob,
  type SystemMedia,
} from "./apiTypes";
import type { AlbumCard, AlbumPage, ArtistPage, Genre, GenreArtist, GenrePage, Library, Playlist, Track } from "./types";

// Same-origin HTTP backend for the website and installed PWA.
export * from "./apiTypes";

/** The server answers errors (and YouTube Music answers names, like genres) in the app's language. */
const LANG_HEADER = "x-musike-lang";

const failureText = (failure: FailureKind) => {
  const f = getT().features;
  return failure === "authentication" ? f.authExpired : failure === "edge_challenge" ? f.edgeChallenge : failure === "timeout" ? f.networkTimeout : failure === "unexpected_response" ? f.unexpectedResponse : failure === "server" ? f.originFailure : f.networkFailure;
};
async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  if (useSession.getState().offline) throw new ApiError(0, getT().offline.onlineRequired, undefined, "network");
  const { json, ...rest } = init ?? {}; const started = Date.now(); const trace = playbackTrace() || beginPlaybackTrace();
  // Only fixed route categories, never queries, provider URLs or user-controlled path segments.
  const operation = path.startsWith("/api/queue/") ? "queue.prepare" : path.startsWith("/api/history") ? "library.history" :
    path.startsWith("/api/prepare/") ? "media.prepare" : path.startsWith("/api/radio/") ? "radio" : path.startsWith("/api/video-for/") ? "video.lookup" : "api";
  const deadline = /^\/api\/(radio|prepare|queue|video-for)/.test(path) ||
    (!rest.method && /^\/api\/(library|playlists)(?:\/|$)/.test(path));
  const signal = deadline ? AbortSignal.any([...(rest.signal ? [rest.signal] : []), AbortSignal.timeout(20_000)]) : rest.signal;
  recordPlayback("http.start", { traceId: trace, operation });
  let res: Response;
  try { res = await fetch(path, { ...rest, redirect: "manual", credentials: "same-origin", signal, headers: {
    [LANG_HEADER]: getLang(), "x-musike-request": "1", ...(trace ? { "x-musike-trace": trace } : {}),
    ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers as Record<string, string> | undefined),
  }, body: json !== undefined ? JSON.stringify(json) : rest.body }); }
  catch (error) {
    if (rest.signal?.aborted) throw error;
    const failure = signal?.aborted ? "timeout" : "network";
    recordPlayback("http.error", { traceId: trace, operation, ms: Date.now() - started, reason: failure });
    throw new ApiError(0, failureText(failure), undefined, failure, trace);
  }
  rest.signal?.throwIfAborted();
  recordPlayback("http.response", { traceId: trace, operation, requestId: res.headers.get("x-musike-request-id") ?? undefined, status: res.status, ms: Date.now() - started, edgeRay: res.headers.get("cf-ray") ?? undefined });
  if (res.status === 204) return undefined as T;
  if (res.status === 401) window.dispatchEvent(new Event("musike:unauthorized"));
  const failure = responseFailure(res);
  if (failure && !res.headers.get("content-type")?.includes("json")) {
    await res.body?.cancel(); recordPlayback("http.error", { traceId: trace, reason: failure, status: res.status });
    throw new ApiError(res.status, failureText(failure), undefined, failure, trace);
  }
  const body = await res.json().catch(() => null);
  rest.signal?.throwIfAborted();
  if (!body) throw new ApiError(res.status, failureText("unexpected_response"), undefined, "unexpected_response", trace);
  if (!res.ok) throw new ApiError(res.status, body.error ?? getT().player.httpError(res.status), body.code, failure ?? undefined, trace);
  return body as T;
}

const clientId = (() => {
  try { const key = "musike:client"; const id = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, id); return id; }
  catch { return crypto.randomUUID(); }
})();
let prefetchRevision = Date.now() * 1000;
export const api: MusikeApi = {
  playbackSettings: async () => {
    const settings = await request<{ lookahead: number; videoQuality: "sd" | "hd"; diagnostics?: boolean }>("/api/playback/settings");
    configurePlaybackDiagnostics(!!settings.diagnostics, async (events) => {
      const response = await fetch("/api/playback/events", { method: "POST", redirect: "manual", credentials: "same-origin", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "x-musike-request": "1" }, body: JSON.stringify({ events }) });
      if (!response.ok || response.redirected) throw new Error("Diagnostics unavailable");
    });
    return settings;
  },
  prefetch: (currentId, upcomingIds) => request<{ lookahead: number; readyIds?: string[] }>("/api/queue/prepare", { method: "POST", json: { clientId, currentId, upcomingIds, revision: ++prefetchRevision } }),
  search: (q: string, type: "song" | "video", signal?: AbortSignal) =>
    request<{ tracks: Track[] }>(`/api/search?q=${encodeURIComponent(q)}&type=${type}`, { signal }).then((r) => r.tracks),
  suggest: (q: string, signal?: AbortSignal) =>
    request<{ suggestions: string[] }>(`/api/suggest?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.suggestions),
  radio: (id: string, signal?: AbortSignal) => request<{ tracks: Track[] }>(`/api/radio/${id}`, { signal }).then((r) => r.tracks),
  genres: () => request<{ genres: Genre[] }>("/api/genres").then((r) => r.genres),
  genre: (id: string, signal?: AbortSignal) => request<GenrePage>(`/api/genres/${encodeURIComponent(id)}`, { signal }),
  genreArtists: (id: string, offset: number) =>
    request<{ artists: GenreArtist[]; hasMore: boolean }>(`/api/genres/${encodeURIComponent(id)}/artists?offset=${offset}`),
  artist: (id: string, signal?: AbortSignal) => request<ArtistPage>(`/api/artists/${encodeURIComponent(id)}`, { signal }),
  album: (id: string, signal?: AbortSignal) => request<AlbumPage>(`/api/albums/${encodeURIComponent(id)}`, { signal }),
  searchAlbums: (q: string, signal?: AbortSignal) =>
    request<{ albums: AlbumCard[] }>(`/api/search/albums?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.albums),
  /** The music video matching a song, or null when YouTube has none. */
  videoFor: (t: Track) =>
    request<{ track: Track | null }>(
      `/api/video-for/${t.id}?${new URLSearchParams({ title: t.title, artist: t.artist, duration: String(t.duration || "") })}`,
    ).then((r) => r.track),
  prepare: (id: string, signal?: AbortSignal) =>
    request<Prepared>(`/api/prepare/${id}`, {
      method: "POST",
      signal,
    }),

  library: (signal) => request<Library>("/api/library", { signal }),
  librarySummary: (signal) => request<LibrarySummary>("/api/library/summary", { signal }),
  libraryFavorites: (signal) => request<{ favorites: Track[] }>("/api/library/favorites", { signal }),
  playlist: (id, signal) => request<Playlist>(`/api/playlists/${encodeURIComponent(id)}`, { signal }),
  playlistMembership: (ids, signal) => request<{ playlists: string[] }>("/api/library/playlist-membership", { method: "POST", json: { ids }, signal }),
  addFavorite: (t, signal) => request<{ favorites: Track[] }>(`/api/favorites/${t.id}`, { method: "PUT", json: t, signal }),
  addFavorites: (tracks, signal) => request<{ favorites: Track[] }>("/api/favorites", { method: "POST", json: { tracks }, signal }),
  removeFavorite: (id, signal) => request<{ favorites: Track[] }>(`/api/favorites/${id}`, { method: "DELETE", signal }),
  deleteTrack: (id, signal) => request<Library>(`/api/library/tracks/${id}`, { method: "DELETE", signal }),
  pushHistory: (t, signal) => request<{ history: Track[] }>("/api/history", { method: "POST", json: t, signal }),
  createPlaylist: (name, tracks, signal) => request<Playlist>("/api/playlists", { method: "POST", json: { name, tracks }, signal }),
  renamePlaylist: (id, name, signal) => request<Playlist>(`/api/playlists/${encodeURIComponent(id)}`, { method: "PATCH", json: { name }, signal }),
  deletePlaylist: (id, signal) => request<void>(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE", signal }),
  addToPlaylist: (id, t, signal) =>
    request<Playlist>(`/api/playlists/${encodeURIComponent(id)}/tracks`, { method: "POST", json: Array.isArray(t) ? { tracks: t } : t, signal }),
  removeFromPlaylist: (id, trackId, signal) =>
    request<Playlist>(`/api/playlists/${encodeURIComponent(id)}/tracks/${trackId}`, { method: "DELETE", signal }),
  importLibrary: (backup, mode, signal) =>
    request<ImportResult>("/api/library/import", { method: "POST", json: { backup, mode }, signal }),

  system: () => request<SystemInfo>("/api/system"),
  updateYtdlp: (channel: Channel) => request<SystemJob>("/api/system/ytdlp", { method: "POST", json: { channel } }),
};

/** What a media element plays for a track: the server's same-origin stream proxy. */
export const streamSource = (id: string, kind: "audio" | "video", quality: "sd" | "hd", trace = playbackTrace()): string | Promise<string> =>
  kind === "audio" ? `/api/stream/${id}/audio?trace=${encodeURIComponent(trace)}` : `/api/stream/${id}/video?q=${quality}&trace=${encodeURIComponent(trace)}`;

/** Saves a text file the way this platform does it: a browser download. */
export async function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Browser media controls use the Media Session API. */
export const systemMedia: SystemMedia | null = null;

/** Supported web/PWA capabilities. */
export const capabilities = { video: true, engineSettings: true, retryOnError: false };

/** Media elements hide the HTTP error body; fetch it to show the real reason. */
export async function explainStreamError(url: string, mediaCode?: number): Promise<{ message: string; code?: ErrorCode; failure?: FailureKind }> {
  const t = getT();
  try {
    const probe = new URL(url, location.href); probe.searchParams.set("probe", "1");
    const res = await fetch(probe, { redirect: "manual", credentials: "same-origin", signal: AbortSignal.timeout(8000), headers: { [LANG_HEADER]: getLang() } });
    if (res.status === 401) window.dispatchEvent(new Event("musike:unauthorized"));
    const failure = responseFailure(res);
    if (!res.headers.get("content-type")?.includes("json")) {
      await res.body?.cancel(); const kind = failure ?? "unexpected_response";
      recordPlayback("media.probe_error", { status: res.status, reason: kind, edgeRay: res.headers.get("cf-ray") ?? undefined });
      return { message: failureText(kind), failure: kind };
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return mediaCode === 2 ? { message: failureText("network"), failure: "network" } : { message: t.player.browserCantPlay };
    recordPlayback("media.probe_error", { status: res.status, reason: failure ?? "server", edgeRay: res.headers.get("cf-ray") ?? undefined });
    return { message: body.error ?? failureText(failure ?? "server"), code: body.code, failure: failure ?? undefined };
  } catch (error) {
    const failure = (error as Error).name === "TimeoutError" ? "timeout" : "network";
    recordPlayback("media.probe_error", { reason: failure }); return { message: failureText(failure), failure };
  }
}
