import { normalizationOf, type Normalization } from "./audioNormalizationCore";
import { getT } from "../i18n";
import { useOffline } from "../stores/offline";
import { useSession } from "../stores/session";
import type { Library, Playlist, Track } from "./types";
import { BUDGETS, MAX_AUDIO, MIB, offlineSettings, offlineSummary, readOfflineLibrary, saveOfflineLibrary, purgeOfflineOwner, readOfflineAudio, removeOfflineTrack, removeOfflinePin, saveOfflineAudio, touchOfflineAudio, trimOfflineAudio, writeOfflinePin } from "./offlineStore";

const OWNER = "musike:offline-owner";
export const offlineOwner = () => { try { return sessionStorage.getItem("musike:user") || null; } catch { return null; } };
let generation = 0;
let controller: AbortController | null = null;
let recent: Track | null = null;
const requested = new Map<string, Track>();
let pendingPin: Playlist | null = null;
let running = false;
const notify = (message = "changed") => { if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("musike-offline"); channel.postMessage(message); channel.close(); } };
export async function refreshOffline() {
  const owner = offlineOwner(); if (!owner) return;
  try {
    const summary = await offlineSummary(owner); if (owner !== offlineOwner()) return;
    const estimate = await navigator.storage?.estimate().catch(() => null);
    const persistent = await navigator.storage?.persisted?.().catch(() => false);
    useOffline.setState({ summary, siteUsage: estimate?.usage ?? null, persistent: persistent ?? false });
  } catch { useOffline.setState({ error: getT().offline.storageUnavailable }); }
}
export function forgetOfflineAccount() { cancelOfflineDownloads(); localStorage.removeItem(OWNER); }
export async function rememberOfflineAccount(id: string, name: string, normalization?: Normalization) {
  try {
    if (offlineOwner() !== id) return;
    await offlineSettings(id, { name, normalization: normalizationOf(normalization) });
    if (offlineOwner() === id) localStorage.setItem(OWNER, id);
  } catch {}
}
export async function cachedOfflineAccount() {
  try {
    const owner = localStorage.getItem(OWNER); if (!owner) return null;
    const { settings, entries } = await offlineSummary(owner);
    if (!settings.enabled && !entries.length) return null;
    return { id: owner, normalization: normalizationOf(settings.normalization), name: settings.name, phone: "", role: "user" as const, status: "active" };
  } catch { return null; }
}
export async function rememberOutput(eligible: boolean, active?: string | null, deviceId?: string, transfer = false) {
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined") return;
  try {
    const key = `musike:output-device:${owner}`;
    if (eligible && deviceId) localStorage.setItem(key, deviceId);
    if (!eligible && !transfer && active && active === localStorage.getItem(key)) return;
    await offlineSettings(owner, { eligible });
  } catch {}
}
export async function setOfflineBudget(mib: number, enabled: boolean) {
  const owner = offlineOwner(); if (!owner || !BUDGETS.includes(mib as typeof BUDGETS[number])) return;
  cancelOfflineDownloads();
  await offlineSettings(owner, { enabled, budget: mib * MIB });
  if (enabled) await navigator.storage?.persist?.().catch(() => false);
  await trimOfflineAudio(owner); await refreshOffline(); notify();
}
export function cancelOfflineDownloads() { useOffline.setState({ progress: [] }); generation++; controller?.abort(); controller = null; recent = null; pendingPin = null; requested.clear(); }
/** No range response, opaque response, HTML or video MIME can become a downloaded song. */
export async function fetchCompleteAudio(id: string, signal: AbortSignal, transport: typeof fetch = fetch, progress?: (bytes: number, total: number | null) => void): Promise<Blob> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("audio");
  const response = await transport(`/api/stream/${id}/audio`, { credentials: "same-origin", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
  const type = response.headers.get("content-type") ?? "";
  const length = Number(response.headers.get("content-length"));
  if (response.status === 401) window.dispatchEvent(new Event("musike:unauthorized"));
  if (response.status !== 200 || response.redirected || !type.startsWith("audio/") || !response.body || Number(response.headers.get("content-length")) > MAX_AUDIO) { await response.body?.cancel(); throw new Error("audio"); }
  const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; progress?.(bytes, length > 0 ? length : null); if (bytes > MAX_AUDIO) throw new Error("limit"); chunks.push(new Uint8Array(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  if (!bytes || length > 0 && bytes !== length || signal.aborted) throw new Error("audio");
  return new Blob(chunks, { type });
}
export async function offlineAudioBlob(id: string) {
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined") return null;
  try { return await readOfflineAudio(owner, id); } catch { return null; }
}
export async function offlineAudioUrl(id: string) {
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined") return null;
  try { const blob = await readOfflineAudio(owner, id); return blob ? URL.createObjectURL(blob) : null; } catch { return null; }
}
/** Explicit click queues a bounded unpinned audio download; it never starts playback. */
export async function downloadOfflineTrack(track: Track) {
  const owner = offlineOwner(); if (!owner || useSession.getState().offline) throw new Error(getT().offline.onlineRequired);
  const summary = await offlineSummary(owner);
  if (!summary.settings.enabled) throw new Error(getT().offline.enableFirst);
  if (requested.size >= 100) throw new Error(getT().offline.downloadQueueFull);
  await offlineSettings(owner, { deleted: (summary.settings.deleted ?? []).filter(id => id !== track.id) });
  requested.set(track.id, track); void drain();
}
export async function snapshotOfflineLibrary(library: Library) {
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined" || useSession.getState().offline) return;
  try { await saveOfflineLibrary(owner, library); }
  catch { if (offlineOwner() === owner) useOffline.setState({ error: getT().offline.metadataUnavailable }); }
}
export async function offlineLibrarySnapshot(): Promise<Library> {
  const owner = offlineOwner(); if (!owner) return { favorites: [], history: [], playlists: [] };
  const stored = await readOfflineLibrary(owner);
  if (stored) return stored;
  const summary = await offlineSummary(owner);
  return { favorites: [], history: summary.entries.map(e => e.track), playlists: summary.pins.map(p => p.pending ?? p.playlist) };
}
export function cacheRecentAudio(track: Track) {
  const owner = offlineOwner(); if (!owner || useSession.getState().offline) return;
  recent = track; void drain();
}
export async function retainPreloadedAudio(track: Track, blob: Blob) {
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined") return;
  try { if (await saveOfflineAudio(owner, track, blob)) { await refreshOffline(); notify(); } } catch {} // Playback never waits for persistence.
}
export async function touchDownloadedAudio(id: string) {
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined") return;
  try { await touchOfflineAudio(owner, id); } catch {}
}
export async function pinOfflinePlaylist(playlist: Playlist) {
  const owner = offlineOwner(); if (!owner || useSession.getState().offline) return;
  const summary = await offlineSummary(owner);
  if (!summary.settings.enabled) { useOffline.setState({ error: getT().offline.enableFirst }); return; }
  const old = summary.pins.find(p => p.id === playlist.id);
  await writeOfflinePin({ owner, id: playlist.id, playlist: old?.playlist ?? { ...playlist, tracks: [] }, pending: playlist, error: "" });
  await offlineSettings(owner, { deleted: (summary.settings.deleted ?? []).filter(id => !playlist.tracks.some(t => t.id === id)) });
  pendingPin = playlist; recent = null; await refreshOffline(); void drain();
}
export async function unpinOfflinePlaylist(id: string) {
  const owner = offlineOwner(); if (!owner) return;
  cancelOfflineDownloads(); await removeOfflinePin(owner, id); await trimOfflineAudio(owner); await refreshOffline(); notify();
}
export async function clearOfflineRecents() {
  const owner = offlineOwner(); if (!owner) return;
  cancelOfflineDownloads(); await trimOfflineAudio(owner, true); await refreshOffline(); notify();
}
export async function logoutOfflineData() {
  const owner = offlineOwner(); cancelOfflineDownloads();
  // Remove the offline entry point before cleanup; a failed deletion never permits offline login.
  localStorage.removeItem(OWNER); sessionStorage.removeItem("musike:user");
  if (owner) { localStorage.removeItem(`musike:output-device:${owner}`); localStorage.removeItem(`musike:player:${owner}`); await purgeOfflineOwner(owner); }
  useOffline.setState({ summary: null }); notify(`logout:${owner}`);
}
async function drain() {
  if (running || useSession.getState().offline || navigator.onLine === false) return;
  const owner = offlineOwner(); if (!owner || typeof indexedDB === "undefined") return;
  running = true; const stamp = generation; useOffline.setState({ busy: true, error: "" });
  try {
    const summary = await offlineSummary(owner); if (!summary.settings.enabled) { recent = null; pendingPin = null; requested.clear(); return; }
    const playlist = pendingPin; pendingPin = null;
    const explicit = playlist ? undefined : requested.values().next().value as Track | undefined;
    if (explicit) requested.delete(explicit.id);
    const track = explicit ?? recent; if (!explicit) recent = null;
    const tracks = playlist?.tracks ?? (track ? [track] : []);
    useOffline.setState({ progress: tracks.map(item => ({ id: item.id, title: item.title, status: "queued" as const, bytes: 0, total: null })) });
    const progress = (id: string, patch: Partial<import("../stores/offline").DownloadProgress>) => {
      if (stamp === generation && owner === offlineOwner()) useOffline.setState(s => ({ progress: s.progress.map(p => p.id === id ? { ...p, ...patch } : p) }));
    };
    for (const item of tracks) {
      if (stamp !== generation || owner !== offlineOwner()) return;
      controller = new AbortController();
      if (!await readOfflineAudio(owner, item.id)) {
        progress(item.id, { status: "downloading" });
        const blob = await fetchCompleteAudio(item.id, controller.signal, fetch, (bytes, total) => progress(item.id, { bytes, total }));
        if (stamp !== generation || owner !== offlineOwner()) return;
        if (!await saveOfflineAudio(owner, item, blob, playlist ? 0 : Date.now())) throw new Error("budget");
        progress(item.id, { status: "ready", bytes: blob.size, total: blob.size });
      } else if (!playlist) await touchOfflineAudio(owner, item.id);
      progress(item.id, { status: "ready" });
      await refreshOffline();
    }
    if (playlist && stamp === generation) await writeOfflinePin({ owner, id: playlist.id, playlist, pending: null, error: "" });
  } catch (e) {
    if (stamp === generation) {
      const error = (e as Error).message === "budget" ? getT().offline.budgetFull : getT().offline.incomplete;
      useOffline.setState(s => ({ error, progress: s.progress.map(p => p.status === "downloading" ? { ...p, status: "failed" as const } : p) }));
    }
  } finally {
    running = false; controller = null; useOffline.setState({ busy: false }); await refreshOffline(); notify();
    if (recent || pendingPin || requested.size) void drain();
  }
}
/** An interrupted pin remains checkpointed. Resumption is an explicit user action. */
export const playlistRevision = (p: Playlist) => JSON.stringify([p.name, p.tracks.map(t => [t.id, t.title, t.artist])]);

/** Only this browser installation is purged; no other device download receives a tombstone. */
export async function deleteLocalAudio(id: string) {
  const owner = offlineOwner(); if (!owner) return;
  cancelOfflineDownloads(); await removeOfflineTrack(owner, id); await refreshOffline(); notify();
}
