import type { LibrarySummary } from "../../../server/src/librarySummary.js";
import type { FailureKind } from "./playbackDiagnostics";
import type { AlbumCard, AlbumPage, ArtistPage, Genre, GenreArtist, GenrePage, Library, Playlist, Track } from "./types";

/**
 * What the app needs from a backend. The website and installed PWA talk to the Musike server over HTTP (lib/api.ts).
 */

export type ErrorCode = "tool_missing" | "maybe_outdated" | "bot_check" | "server_busy";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: ErrorCode, public failure?: FailureKind, public traceId?: string) {
    super(message);
  }
}

export type Channel = "stable" | "nightly";

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  skipped?: number;
  favoritesAdded: number;
}

export interface SystemJob {
  kind: "update" | "install";
  channel: Channel;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  from: string | null;
  to: string | null;
  message: string;
  log: string[];
}

export interface SystemInfo {
  ytdlp: {
    path: string | null;
    version: string | null;
    channel: Channel;
    latest: Record<Channel, string | null>;
    updateAvailable: boolean;
  };
  deno: string | null;
  ffmpeg: string | null;
  canInstall: boolean;
  job: SystemJob | null;
}

export interface Prepared {
  id: string;
  title: string;
  duration: number;
  hasSdVideo: boolean;
}

export interface MusikeApi {
  search(q: string, type: "song" | "video", signal?: AbortSignal): Promise<Track[]>;
  suggest(q: string, signal?: AbortSignal): Promise<string[]>;
  radio(id: string, signal?: AbortSignal): Promise<Track[]>;
  genres(): Promise<Genre[]>;
  genre(id: string, signal?: AbortSignal): Promise<GenrePage>;
  genreArtists(id: string, offset: number): Promise<{ artists: GenreArtist[]; hasMore: boolean }>;
  artist(id: string, signal?: AbortSignal): Promise<ArtistPage>;
  album(id: string, signal?: AbortSignal): Promise<AlbumPage>;
  searchAlbums(q: string, signal?: AbortSignal): Promise<AlbumCard[]>;
  /** The music video matching a song, or null when YouTube has none. */
  videoFor(t: Track): Promise<Track | null>;
  prefetch?(currentId: string, upcomingIds: string[]): Promise<{ lookahead: number; readyIds?: string[] } | void>;
  playbackSettings?(): Promise<{ lookahead: number; videoQuality: "sd" | "hd"; diagnostics?: boolean } >;
  prepare(id: string, signal?: AbortSignal): Promise<Prepared>;

  library(signal?: AbortSignal): Promise<Library>;
  librarySummary(signal?: AbortSignal): Promise<LibrarySummary>;
  libraryFavorites(signal?: AbortSignal): Promise<{ favorites: Track[] }>;
  playlist(id: string, signal?: AbortSignal): Promise<Playlist>;
  playlistMembership(ids: string[], signal?: AbortSignal): Promise<{ playlists: string[] }>;
  addFavorite(t: Track, signal?: AbortSignal): Promise<{ favorites: Track[] }>;
  addFavorites(tracks: Track[], signal?: AbortSignal): Promise<{ favorites: Track[] }>;
  removeFavorite(id: string, signal?: AbortSignal): Promise<{ favorites: Track[] }>;
  deleteTrack(id: string, signal?: AbortSignal): Promise<Library>;
  pushHistory(t: Track, signal?: AbortSignal): Promise<{ history: Track[] }>;
  createPlaylist(name: string, tracks?: Track[], signal?: AbortSignal): Promise<Playlist>;
  renamePlaylist(id: string, name: string, signal?: AbortSignal): Promise<Playlist>;
  deletePlaylist(id: string, signal?: AbortSignal): Promise<void>;
  addToPlaylist(id: string, t: Track | Track[], signal?: AbortSignal): Promise<Playlist>;
  removeFromPlaylist(id: string, trackId: string, signal?: AbortSignal): Promise<Playlist>;
  importLibrary(backup: unknown, mode: "merge" | "replace", signal?: AbortSignal): Promise<ImportResult>;

  system(): Promise<SystemInfo>;
  updateYtdlp(channel: Channel): Promise<SystemJob>;
}
