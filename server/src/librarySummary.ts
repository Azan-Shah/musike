import type { Library, Playlist, Track } from "./types.js";

export type CoverArtwork = Pick<Track, "id" | "thumb" | "art">;
export type PlaylistSummary = Omit<Playlist, "tracks"> & { trackCount: number; cover: CoverArtwork[] };
export interface LibrarySummary {
  playlists: PlaylistSummary[];
  favorites: { ids: string[]; preview: Track[] };
  history: Track[];
}

export const FAVORITES_PREVIEW_SIZE = 5;

export function coverArtwork(tracks: readonly CoverArtwork[]): CoverArtwork[] {
  const cover: CoverArtwork[] = [];
  const seen = new Set<string>();
  for (const { id, thumb, art } of tracks) {
    if (seen.has(thumb)) continue;
    seen.add(thumb);
    cover.push({ id, thumb, art });
    if (cover.length === 4) break;
  }
  return cover;
}

const covers = new WeakMap<Track[], { count: number; artwork: CoverArtwork[] }>();
export function describePlaylist({ id, name, origin, createdAt, updatedAt, tracks }: Playlist): PlaylistSummary {
  let cached = covers.get(tracks);
  // Playlist edits replace the track array or append to it.
  if (cached?.count !== tracks.length) {
    cached = { count: tracks.length, artwork: coverArtwork(tracks) };
    covers.set(tracks, cached);
  }
  return { id, name, origin, createdAt, updatedAt, trackCount: tracks.length, cover: cached.artwork };
}

export function summarizeLibrary(library: Library): LibrarySummary {
  return {
    playlists: library.playlists.map(describePlaylist),
    favorites: { ids: library.favorites.map(track => track.id), preview: library.favorites.slice(0, FAVORITES_PREVIEW_SIZE) },
    history: library.history.slice(0, 60),
  };
}
