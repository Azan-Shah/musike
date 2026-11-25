import { accountRequest } from "../stores/session";
import type { Playlist, Track } from "./types";
export interface SocialState {
  shareOffset: number; hasMore: boolean; code: string; preferences: { online: boolean; track: boolean };
  friends: { id: string; name: string; online: boolean | null; track: Track | null }[];
  requests: { sender: string; recipient: string; name: string }[];
  groups: { id: string; owner_id: string; name: string }[];
  owned: { id: string; playlist_id: string }[];
  shares: { id: string; name: string; owner: { id: string; name: string }; permission: string; tracks: number }[];
}
export interface SharedPlaylistView { id: string; owner: { id: string; name: string }; permission: string; playlist: Playlist }
export const socialOverview = (signal: AbortSignal) =>
  accountRequest<SocialState>("/api/social?includeShares=0", undefined, undefined, signal);
export const socialPresence = (signal: AbortSignal) =>
  accountRequest<Pick<SocialState, "friends">>("/api/social/presence", undefined, undefined, signal);
export const sharedPlaylist = (id: string) => accountRequest<SharedPlaylistView>(`/api/shared-playlists/${encodeURIComponent(id)}`);

export const incomingShares = (offset: number, limit: number, signal: AbortSignal) =>
  accountRequest<Pick<SocialState, "shareOffset" | "hasMore" | "shares">>(
    `/api/social/shares?offset=${offset}&limit=${limit}`, undefined, undefined, signal);
