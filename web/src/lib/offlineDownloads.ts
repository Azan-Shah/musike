import { normalizationOf, rememberResponseLoudness, type Normalization } from "./audioNormalizationCore";
import { getT } from "../i18n";
import { useOffline, type DownloadProgress } from "../stores/offline";
import { useSession } from "../stores/session";
import type { Library, Playlist, Track } from "./types";
import { BUDGETS, MAX_AUDIO, MIB, offlineSettings, offlineSummary, readOfflineLibrary, saveOfflineLibrary, purgeOfflineOwner, offlineAudioEntry, readOfflineAudio, removeOfflineTrack, removeOfflinePin, saveOfflineAudio, touchOfflineAudio, trimOfflineAudio, writeOfflinePin } from "./offlineStore";

const OWNER = "musike:offline-owner";
export const offlineOwner = () => { try { return sessionStorage.getItem("musike:user") || null; } catch { return null; } };
let generation = 0;
let controller: AbortController | null = null;
let recent: Track | null = null;
const requested = new Map<string, Track>();
let pendingPin: Playlist | null = null;
let running = false;
const notify = (message = "changed") => { if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("musike-offline"); channel.postMessage(message); channel.close(); } };
let refreshRevision = 0;
export async function refreshOffline() {
  const owner = offlineOwner(); if (!owner) return;
  const revision = ++refreshRevision;
  const current = () => revision === refreshRevision && owner === offlineOwner();
  try {
    const [summary, estimate, persistent] = await Promise.all([
      offlineSummary(owner), navigator.storage?.estimate().catch(() => null), navigator.storage?.persisted?.().catch(() => false),
    ]);
    if (current()) useOffline.setState({ summary, siteUsage: estimate?.usage ?? null, persistent: persistent ?? false });
  } catch { if (current()) useOffline.setState({ error: getT().offline.storageUnavailable }); }
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
  return rememberResponseLoudness(new Blob(chunks, { type }), response);
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
  const current = () => stamp === generation && owner === offlineOwner();
  const items = new Map<string, DownloadProgress>();
  let activeId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSummaryAt = Date.now();
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (current()) useOffline.setState({ progress: [...items.values()] });
  }
  function progress(id: string, patch: Partial<DownloadProgress>) {
    const item = items.get(id);
    if (!current() || !item) return;
    items.set(id, { ...item, ...patch });
    timer ??= setTimeout(flush, 120);
  }
  try {
    const summary = await offlineSummary(owner);
    if (!current()) return;
    if (!summary.settings.enabled) { recent = null; pendingPin = null; requested.clear(); return; }
    const playlist = pendingPin; pendingPin = null;
    const explicit = playlist ? undefined : requested.values().next().value as Track | undefined;
    if (explicit) requested.delete(explicit.id);
    const track = explicit ?? recent; if (!explicit) recent = null;
    const tracks = playlist?.tracks ?? (track ? [track] : []);
    for (const item of tracks) items.set(item.id, { id: item.id, title: item.title, status: "queued", bytes: 0, total: null });
    flush();
    for (const item of tracks) {
      if (!current()) return;
      activeId = item.id;
      controller = new AbortController();
      const cached = await offlineAudioEntry(owner, item.id);
      if (!current()) return;
      if (!cached) {
        progress(item.id, { status: "downloading" });
        const blob = await fetchCompleteAudio(item.id, controller.signal, fetch, (bytes, total) => progress(item.id, { bytes, total }));
        if (!current()) return;
        if (!await saveOfflineAudio(owner, item, blob, playlist ? 0 : Date.now())) throw new Error("budget");
        progress(item.id, { status: "ready", bytes: blob.size, total: blob.size });
        if (Date.now() - lastSummaryAt >= 1000) { await refreshOffline(); lastSummaryAt = Date.now(); }
      } else {
        if (!playlist) await touchOfflineAudio(owner, item.id);
        progress(item.id, { status: "ready", bytes: cached.bytes, total: cached.bytes });
      }
    }
    if (playlist && current()) await writeOfflinePin({ owner, id: playlist.id, playlist, pending: null, error: "" });
  } catch (e) {
    if (current()) {
      if (activeId) progress(activeId, { status: "failed" });
      const error = (e as Error).message === "budget" ? getT().offline.budgetFull : getT().offline.incomplete;
      useOffline.setState({ error });
    }
  } finally {
    flush();
    running = false; controller = null; useOffline.setState({ busy: false });
    if (current()) { await refreshOffline(); notify(); }
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
