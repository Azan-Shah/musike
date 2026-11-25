import { mediaMetadata, mediaPlaybackState, registerMediaActions } from "../lib/mediaSession";
import { cacheRecentAudio, offlineAudioBlob, retainPreloadedAudio, touchDownloadedAudio } from "../lib/offlineDownloads";
import { useSession } from "../stores/session";
import { PlaybackWindow } from "../lib/playbackWindow";
import { nextDownloaded } from "../lib/playbackFallback";
import { AudioNormalization } from "../lib/audioNormalization";
import { loudnessOf, normalizationOf } from "../lib/audioNormalizationCore";
import { create } from "zustand";
import { getT, useT } from "../i18n";
import { api, capabilities, explainStreamError, saveFile, streamSource, type ApiError, type ErrorCode } from "../lib/api";
import { beginPlaybackTrace, recordPlayback, playbackEvents, flushPlaybackEvents, type FailureKind } from "../lib/playbackDiagnostics";
import { recoverableFailure, requestRadio } from "../lib/playbackRecovery";
import { createAudio } from "../lib/audio";
import { shuffled } from "../lib/format";
import type { Track } from "../lib/types";
import { playerWriter, type SavedPlayer as Saved } from "../lib/playerPersistence";
import { upcomingTracks } from "../lib/playbackQueue";
import { SessionCache } from "../lib/sessionCache";
import { playbackCanOutput, playbackInJam } from "../lib/playbackSync";
import type { SharedPlayback } from "../lib/playbackSync";
import { useLibrary } from "../stores/library";
import { openSettings } from "../stores/system";
import { toast } from "../stores/ui";

export type Repeat = "off" | "all" | "one";
/** A code translated where it is shown (so switching languages updates it), or a server error already in the right language. */
export type StatusNote = "findingClip" | "preparingHd" | "loadingVideo" | "fetchingRadio" | { error: string };
export type Status = "idle" | "loading" | "playing" | "paused" | "error";
type Kind = "audio" | "video";
type Quality = "sd" | "hd";

export interface PlayerState {
  queue: Track[];
  /** Queue order before shuffle was turned on, restored when it is turned off. */
  original: Track[] | null;
  index: number;
  status: Status;
  /** What playback is busy with (or why it failed), shown instead of the artist. See `useStatusText`. */
  statusText: StatusNote | null;
  /** Which media element is driving playback right now. */
  mediaKind: Kind;
  /** Set when Video mode is on but the current song has no music video on YouTube. */
  videoNote: "noClip" | null;
  /** Intrinsic width/height of the current video, so vertical videos get a vertical stage. */
  videoAspect: number;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  autoRadio: boolean;

  playList: (tracks: Track[], start?: number) => void;
  playTrack: (track: Track) => void;
  playNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  removeAt: (i: number) => void;
  jumpTo: (i: number) => void;
  clearUpcoming: () => void;
  startRadio: (track: Track) => Promise<void>;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setPreferVideo: (on: boolean) => void;
  setQuality: (q: Quality) => void;
  setAutoRadio: (on: boolean) => void;
  warmUpcoming: () => void;
  stopSession: () => void;
  suspendOutput: () => void;
  resumeOutput: (snapshot: SharedPlayback) => void;
}

// Media elements live outside React so playback survives any re-render or route change.
// The website and installed PWA share this browser audio element.
const audio = createAudio();
let resumeWanted = false;
let unlockPending = false;
let recoveryPaused = false;
let lastFailure: FailureKind | undefined;
let recoveryCount = 0;
let unlockRecoveryUsed = false;
const completePreload = new PlaybackWindow(fetch, 16 * 1024 * 1024, (id, blob) => {
  const track = usePlayer.getState().queue.find(t => t.id === id);
  if (track) void retainPreloadedAudio(track, blob);
}, offlineAudioBlob);
const normalization = new AudioNormalization();
let automaticTrack = false;
let endedToken = -1;
let activeBlob: string | null = null;
let recoveryId = "";

export const videoEl = document.createElement("video");
videoEl.playsInline = true;
videoEl.preload = "auto";
videoEl.setAttribute("playsinline", "");
videoEl.className = "block h-full w-full object-contain bg-black";

const mediaFor = (k: Kind): HTMLMediaElement => (k === "video" ? videoEl : audio);

let loaded: { id: string; kind: Kind; quality: Quality } | null = null;
let pendingSeek = 0;
let token = 0;
let recordedToken = -1;
let sessionLost = false;
let lookahead = 3;
let qualityChanged = false;
let loadingAt = Date.now();
let onLoadingDeadline = () => {};
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const cancelRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; };
function mediaFields(media: HTMLMediaElement) {
  let buffered = 0;
  for (let n = 0; n < media.buffered.length; n++) {
    const start = typeof media.buffered.start === "function" ? media.buffered.start(n) : 0;
    if (start <= media.currentTime + .1 && media.buffered.end(n) >= media.currentTime) buffered = media.buffered.end(n) - media.currentTime;
  }
  return { position: media.currentTime, buffered, readyState: media.readyState, networkState: media.networkState, mediaCode: media.error?.code };
}

const STORAGE_KEY = `musike:player${sessionStorage.getItem("musike:user") ? `:${sessionStorage.getItem("musike:user")}` : ""}`;

function readSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}

const saved = readSaved();

/**
 * Songs from YouTube Music are "art tracks": audio with a still cover. In Video mode we play the
 * song's music video instead. Song id → video id, or null when YouTube has no clip for it.
 */
const clipFor = new SessionCache<string, string | null>(200, 6 * 3600_000);
const clipLookups = new Map<string, Promise<string | null>>();

function lookupClip(track: Track): Promise<string | null> {
  if (track.kind === "video") return Promise.resolve(track.id);
  if (clipFor.has(track.id)) return Promise.resolve(clipFor.get(track.id)!);
  let lookup = clipLookups.get(track.id);
  if (!lookup) {
    lookup = api
      .videoFor(track)
      .then(
        (v) => {
          const id = v?.id ?? null;
          clipFor.set(track.id, id);
          return id;
        },
        () => null, // network hiccup: don't remember it, try again next time
      )
      .finally(() => clipLookups.delete(track.id));
    clipLookups.set(track.id, lookup);
  }
  return lookup;
}

const needsClipLookup = (track: Track, preferVideo: boolean) =>
  preferVideo && track.kind === "song" && !clipFor.has(track.id);

export const usePlayer = create<PlayerState>((set, get) => {
  const kindFor = (track: Track): Kind =>
    !useSession.getState().offline && capabilities.video && get().preferVideo && (track.kind === "video" || !!clipFor.get(track.id)) ? "video" : "audio";
  /** The YouTube id to stream: the song itself, or its music video in Video mode. */
  const mediaIdFor = (track: Track, kind: Kind) =>
    kind === "video" && track.kind !== "video" ? clipFor.get(track.id)! : track.id;
  const noteFor = (track: Track) =>
    get().preferVideo && track.kind === "song" && clipFor.get(track.id) === null ? ("noClip" as const) : null;
  const activeMedia = (): HTMLMediaElement | null => (loaded ? mediaFor(loaded.kind) : null);

  function play(media: HTMLMediaElement, fallback?: () => void) {
    const mine = token;
    const current = () => mine === token && !sessionLost && playbackCanOutput() && activeMedia() === media;
    normalization.start(media, current);
    media.play().then(() => { if (current() && !media.paused) normalization.playing(media); }).catch((err: DOMException) => {
      if (mine !== token || err.name === "AbortError") return; // src changed mid-start
      if (err.name === "NotAllowedError") { if (fallback) fallback(); else { resumeWanted = false; set({ status: "paused" }); } } // autoplay blocked
    });
  }

  function load(index: number, opts: { autoplay?: boolean; startAt?: number; disablePreload?: boolean; automatic?: boolean; body?: Blob } = {}) {
    if (sessionLost || !playbackCanOutput()) return;
    cancelRetry();
    manualRadio?.abort();
    const s = get();
    const track = s.queue[index];
    if (!track) return;
    if (recoveryId !== track.id) { recoveryId = track.id; recoveryCount = 0; unlockRecoveryUsed = false; }
    resumeWanted = opts.autoplay !== false;
    if (!opts.disablePreload) unlockPending = false;
    recoveryPaused = false;
    const offline = !!useSession.getState().offline;
    automaticTrack = !!opts.automatic;
    const complete = !opts.disablePreload && (!s.preferVideo || offline) ? completePreload.take(track.id) : null;
    completePreload.retain(upcomingTracks(s.queue, index, Math.min(3, lookahead), s.repeat).map(t => t.id));
    const trace = complete?.trace;
    beginPlaybackTrace(trace); recordPlayback("player.load", { videoId: track.id });

    // Video mode on a song: find its music video first, then load whichever fits.
    if (!opts.body && !offline && needsClipLookup(track, s.preferVideo)) {
      const mine = ++token;
      set({
        index,
        status: "loading",
        statusText: "findingClip",
        videoNote: null,
        position: opts.startAt ?? 0,
        duration: track.duration,
        buffered: 0,
      });
      const previous = activeMedia();
      if (previous) { normalization.cancel(previous); previous.pause(); }
      setMetadata(track);
      void lookupClip(track).then(() => mine === token && load(index, opts));
      return;
    }

    const kind = opts.body ? "audio" : kindFor(track);
    const media = mediaFor(kind);
    const other = mediaFor(kind === "video" ? "audio" : "video");
    normalization.cancel(other);
    other.pause();
    if (other.getAttribute("src")) {
      other.removeAttribute("src");
      other.load();
    }

    token++; loadingAt = Date.now();
    loaded = { id: track.id, kind, quality: s.quality };
    pendingSeek = opts.startAt ?? 0;
    const autoplay = opts.autoplay !== false;
    set({
      index,
      mediaKind: kind,
      status: autoplay ? "loading" : "paused",
      // Video may need a server-side download first (HD, or videos without a combined SD stream).
      statusText: kind === "video" ? (s.quality === "hd" ? "preparingHd" : "loadingVideo") : null,
      videoNote: noteFor(track),
      position: pendingSeek,
      duration: track.duration,
      buffered: 0,
    });
    normalization.setVolume(media, s.volume, s.muted);
    media.loop = s.repeat === "one";
    const start = (src: string, body?: Blob) => {
      normalization.arm(media, body ? loudnessOf(body) : undefined);
      media.src = src;
      if (autoplay) play(media);
    };
    // The same-origin proxy URL is synchronous; resolution stays on the server.
    if (activeBlob) { URL.revokeObjectURL(activeBlob); activeBlob = null; }
    if (opts.body && kind === "audio") {
      activeBlob = URL.createObjectURL(opts.body); start(activeBlob, opts.body);
      recordPlayback("player.downloaded_fallback", { videoId: track.id }); setMetadata(track); return;
    }
    if (complete && kind === "audio") {
      activeBlob = complete.url; start(complete.url, complete.blob);
      recordPlayback("player.complete_handoff", { videoId: track.id, traceId: complete.trace });
      setMetadata(track); return;
    }
    const mine = token;
    const network = () => {
      if (offline) { resumeWanted = false; set({ status: "paused", statusText: { error: getT().offline.unavailable } }); return; }
      start(streamSource(mediaIdFor(track, kind), kind, s.quality));
    };
    // Locked transitions keep a synchronous source/play path. Persistent next-track bytes
    // are loaded by warmQueue while the current track is still playing.
    if (kind === "audio" && sessionStorage.getItem("musike:user") && (offline || navigator.userActivation?.isActive)) {
      normalization.cancel(media);
      media.pause();
      void offlineAudioBlob(track.id).then(body => {
        if (mine !== token || !playbackCanOutput()) return;
        if (body) {
          activeBlob = URL.createObjectURL(body);
          start(activeBlob, body);
          void touchDownloadedAudio(track.id);
        } else network();
      });
    } else network();
    setMetadata(track);
  }

  let radioJob: { queue: Track[]; controller: AbortController; promise: Promise<void> } | null = null;
  let radioAttempt: { queue: Track[]; at: number; failed: boolean } | null = null;
  let radioFailure: Error | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  let warmRetries = 0;
  let manualRadio: AbortController | null = null;
  let warming = "";

  function primeRadio(force = false): Promise<void> {
    const s = get();
    if (radioJob && radioJob.queue !== s.queue) { radioJob.controller.abort(); radioJob = null; }
    if (useSession.getState().offline || !s.autoRadio || s.repeat !== "off" || sessionLost) { radioJob?.controller.abort(); return Promise.resolve(); }
    if (radioJob) return radioJob.promise;
    if (!force && (lookahead === 0 || s.queue.length - s.index - 1 >= lookahead)) return Promise.resolve();
    if (radioAttempt?.queue === s.queue && Date.now() - radioAttempt.at < (radioAttempt.failed && force ? 2000 : 30_000)) return Promise.resolve();
    const tail = s.queue.at(-1); if (!tail) return Promise.resolve();
    const queue = s.queue; const controller = new AbortController();
    radioAttempt = { queue, at: Date.now(), failed: false }; radioFailure = null;
    recordPlayback("radio.request", { videoId: tail.id });
    const promise = requestRadio((signal) => api.radio(tail.id, signal), controller.signal).then((tracks) => {
      if (controller.signal.aborted || sessionLost || get().queue !== queue || !get().autoRadio || get().repeat !== "off") return;
      const known = new Set(queue.map((track) => track.id));
      const more = tracks.filter((track) => { if (known.has(track.id)) return false; known.add(track.id); return true; }).slice(0, 25);
      recordPlayback("radio.ready", { videoId: tail.id });
      if (more.length) set((state) => ({ queue: [...queue, ...more], original: state.original ? [...state.original, ...more] : null }));
    }).catch((error) => {
      if (!controller.signal.aborted && get().queue === queue) {
        radioFailure = Object.assign(new Error((error as ApiError).failure === "timeout" ? getT().features.networkTimeout : (error as Error).message), { failure: (error as ApiError).failure, code: (error as ApiError).code }); if (radioAttempt?.queue === queue) { radioAttempt.failed = true; radioAttempt.at = Date.now(); }
        recordPlayback("radio.error", { videoId: tail.id, reason: (error as ApiError).failure ?? "provider" });
      }
    }).finally(() => { if (radioJob?.controller === controller) radioJob = null; });
    radioJob = { queue, controller, promise }; return promise;
  }

  async function continueWithRadio() {
    const index = get().index; const mine = token; recordPlayback("player.advance_radio");
    set({ status: "loading", statusText: "fetchingRadio" });
    await primeRadio(true);
    if (mine !== token || sessionLost) return;
    if (get().queue[index + 1]) { load(index + 1); return; }
    if (radioFailure) { const error = radioFailure as ApiError; report(error.message || getT().features.radioRetry, error.code, error.failure); }
    else set({ status: "paused", statusText: null, position: 0 });
  }

  function warmQueue() {
    if (!playbackCanOutput()) return;
    const s = get();
    const offline = !!useSession.getState().offline;
    if (radioJob && (radioJob.queue !== s.queue || !s.autoRadio || s.repeat !== "off")) { radioJob.controller.abort(); radioJob = null; }
    const current = s.queue[s.index];
    const upcoming = upcomingTracks(s.queue, s.index, 10, s.repeat);
    const nearest = (!s.preferVideo || offline) && (lookahead > 0 || offline) ? upcoming[0] : undefined;
    const window = nearest ? upcoming.slice(0, offline ? 1 : Math.min(3, lookahead)) : [];
    completePreload.retain(window.map(track => track.id));
    if (sessionLost || !current || (s.status !== "playing" && s.status !== "loading")) return;
    const queue = s.queue; const index = s.index;
    if (nearest) {
      const trace = crypto.randomUUID();
      if (offline) void completePreload.hydrate(nearest.id, trace);
      else {
        // Start while the current song is audible. Waiting for readyIds can miss
        // the entire foreground window; the cold audio route already races sources.
        for (const track of window) {
          const source = streamSource(track.id, "audio", s.quality, trace);
          completePreload.prepare(track.id, source, trace);
        }
      }
    }
    if (offline) return;
    const signature = `${current.id}:${upcoming.map((track) => track.id).join(",")}:${s.preferVideo}`;
    if (api.prefetch && warming === signature) return;
    if (api.prefetch) { warming = signature; void api.prefetch(current.id, upcoming.map((track) => track.id)).then((result) => {
      if (sessionLost || get().queue !== queue || get().index !== index) return;
      if (result) lookahead = result.lookahead;
      const next = upcoming[0];
      if (lookahead > 0 && next && !s.preferVideo && result?.readyIds?.includes(next.id)) {
        const trace = crypto.randomUUID();
        const source = streamSource(next.id, "audio", s.quality, trace);
        void completePreload.prepare(next.id, source, trace);
        warmRetries = 0;
      } else if (lookahead > 0 && next && !s.preferVideo && warmRetries++ < 10 && !warmTimer) {
        warmTimer = setTimeout(() => { warmTimer = null; warmQueue(); }, 1500);
      }
      void primeRadio();
    }).catch((error) => recordPlayback("prepare.error", { reason: (error as ApiError).failure ?? "request" }))
      .finally(() => { if (warming === signature) warming = ""; }); }
    else for (const track of upcoming.slice(0, 3)) void api.prepare(track.id).catch(() => {});
    void primeRadio();
    if (s.preferVideo && upcoming[0]) void lookupClip(upcoming[0]).then((id) => api.prepare(id ?? upcoming[0]!.id).catch(() => {}));
  }

  function onStarted() {
    const s = get();
    const track = s.queue[s.index];
    if (!track || recordedToken === token) return;
    recordedToken = token; lastFailure = undefined;
    recordPlayback("player.playing", { videoId: track.id });
    if (!useSession.getState().offline) { useLibrary.getState().recordPlay(track); if (s.mediaKind === "audio") cacheRecentAudio(track); }
    else void touchDownloadedAudio(track.id);
    warmQueue();
  }

  function onEnded() {
    const media = activeMedia();
    if (!media?.ended || endedToken === token || !resumeWanted) return;
    recordPlayback("player.ended_observed", mediaFields(media));
    if (!playbackCanOutput()) { recordPlayback("player.advance_blocked", { reason: "output" }); return; }
    endedToken = token;
    recordPlayback("player.ended");
    const s = get();
    if (s.repeat === "one") {
      const media = activeMedia();
      if (media) {
        resumeWanted = true; pendingSeek = 0;
        set({ position: 0, status: "loading", statusText: null });
        media.currentTime = 0;
        play(media);
      }
      return;
    }
    if (s.index < s.queue.length - 1) return load(s.index + 1, { automatic: true });
    if (s.repeat === "all" && s.queue.length) return load(0, { automatic: true });
    if (s.autoRadio && !useSession.getState().offline) return void continueWithRadio();
    set({ status: "paused", position: 0 });
  }

  /** Shows why a track can't play, then moves on (unless every track would fail the same way). */
  function report(message: string, code?: ErrorCode, failure?: FailureKind) {
    const mine = token; lastFailure = failure; recordPlayback("player.error", { reason: failure ?? code ?? "media" });
    set({ status: "error", statusText: { error: message } });
    const track = get().queue[get().index];
    // Tool problems hit every track: offer the fix instead of skipping through the whole queue.
    const toolProblem = code === "tool_missing" || code === "maybe_outdated";
    const t = getT();
    toast(
      t.player.cantPlay(track?.title ?? t.player.aTrack, message),
      "error",
      toolProblem ? { label: code === "tool_missing" ? t.common.install : t.common.update, run: openSettings } : failure === "authentication" || failure === "edge_challenge" ?
        { label: t.features.signInAgain, run: () => location.reload() } :
        { label: t.features.downloadDiagnostics, run: () => void saveFile("musike-playback-diagnostics.json", JSON.stringify(playbackEvents(), null, 2)) },
    );
    // Unlock can arrive while the asynchronous error probe is still pending.
    if (unlockPending && resumeWanted && recoverableFailure(failure)) queueMicrotask(restorePlayback);
    if (!failure && code !== "tool_missing" && get().index < get().queue.length - 1) {
      setTimeout(() => mine === token && get().next(), 2500);
    }
  }

  let probingToken = -1;

  async function downloadedFallback(mine: number) {
    const state = get(); const queue = state.queue;
    const valid = () => mine === token && !sessionLost && resumeWanted && playbackCanOutput() && !playbackInJam() && get().queue === queue;
    const result = await nextDownloaded(queue, state.index, state.repeat === "all", async id => {
      const prepared = completePreload.take(id);
      if (prepared) { URL.revokeObjectURL(prepared.url); return prepared.blob; }
      return offlineAudioBlob(id);
    }, valid);
    if (!valid()) return;
    if (result) { toast(getT().offline.skippingDownloaded); load(result.index, { automatic: true, body: result.blob }); }
    else {
      // Keep a recoverable error distinct from a deliberate pause so unlock/online can retry.
      recoveryPaused = true;
      set({ status: "paused", statusText: { error: getT().offline.noNextDownloaded } }); activeMedia()?.pause();
      if (unlockPending) queueMicrotask(restorePlayback);
    }
  }
  function onError(media: HTMLMediaElement, stalled = false) {
    if (useSession.getState().offline) {
      if (automaticTrack && !playbackInJam()) { void downloadedFallback(token); return; }
      resumeWanted = false; set({ status: "paused", statusText: { error: getT().offline.unavailable } }); return;
    }
    const mine = token;
    if (probingToken === mine) return;
    const url = media.currentSrc || media.src;
    recordPlayback(stalled ? "media.stalled" : "media.error", mediaFields(media));
    probingToken = mine;
    set({ status: "loading", statusText: null });
    explainStreamError(url, media.error?.code).then(({ message, code, failure }) => {
      if (mine !== token || sessionLost) return;
      // A successful probe describes the origin, not the stalled element. It must not turn a
      // confirmed no-progress deadline into an unsupported-codec failure.
      const emptyNetworkSource = media.error?.code === 4 && media.readyState === 0 && !media.buffered.length && !url.startsWith("blob:");
      const kind = !failure && !code && (stalled || emptyNetworkSource) ? "timeout" : failure;
      lastFailure = kind;
      if (resumeWanted && recoverableFailure(kind) && !code && recoveryCount < 2) {
        const at = media.currentTime || get().position; const index = get().index;
        recoveryCount++; lastFailure = kind;
        recordPlayback("player.retry", { reason: kind, position: at });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (mine === token && !sessionLost && resumeWanted) load(index, { startAt: at, disablePreload: true, automatic: automaticTrack });
        }, 500 * recoveryCount);
      } else if (resumeWanted && automaticTrack && !playbackInJam() && recoverableFailure(kind) && !code) void downloadedFallback(mine);
      else report(stalled && !failure && !code ? getT().features.networkTimeout : message, code, kind);
    }).catch(() => { if (mine === token) report(getT().features.networkFailure, undefined, "network"); });
  }

  onLoadingDeadline = () => { loadingAt = Date.now(); const media = activeMedia(); if (media && resumeWanted) onError(media, true); };

  function wire(media: HTMLMediaElement) {
    const isActive = () => activeMedia() === media;
    media.addEventListener("loadedmetadata", () => {
      if (!isActive()) return;
      if (pendingSeek > 0) {
        media.currentTime = pendingSeek;
        pendingSeek = 0;
      }
      if (Number.isFinite(media.duration)) set({ duration: media.duration });
      if (media === videoEl && videoEl.videoWidth && videoEl.videoHeight) {
        set({ videoAspect: videoEl.videoWidth / videoEl.videoHeight });
      }
      syncPositionState();
    });
    media.addEventListener("durationchange", () => {
      if (isActive() && Number.isFinite(media.duration)) set({ duration: media.duration });
    });
    media.addEventListener("playing", () => {
      if (!isActive() || media.paused) return;
      normalization.playing(media);
      loadingAt = Date.now(); set({ status: "playing", statusText: null });
      onStarted();
      syncPlaybackState();
    });
    media.addEventListener("pause", () => {
      if (!isActive() || !media.paused || media.ended || get().status === "loading" || get().status === "error" || recoveryPaused) return;
      resumeWanted = false; unlockPending = false; set({ status: "paused" });
      syncPlaybackState();
    });
    media.addEventListener("waiting", () => {
      if (isActive() && !media.paused) { if (get().status !== "loading") loadingAt = Date.now(); set({ status: "loading" }); recordPlayback("player.waiting", mediaFields(media)); }
    });
    media.addEventListener("timeupdate", () => {
      if (!isActive() || pendingSeek > 0) return;
      if (Math.abs(media.currentTime - get().position) >= 0.2) { loadingAt = Date.now(); set({ position: media.currentTime }); }
    });
    media.addEventListener("progress", () => {
      if (!isActive() || !media.buffered.length) return;
      set({ buffered: media.buffered.end(media.buffered.length - 1) });
    });
    media.addEventListener("seeked", () => isActive() && syncPositionState());
    media.addEventListener("ended", () => isActive() && onEnded());
    // A resumed media task may expose ended before delivering its event.
    media.addEventListener("timeupdate", () => { if (isActive() && media.ended) onEnded(); });
    media.addEventListener("error", () => isActive() && media.getAttribute("src") && onError(media));
  }
  wire(audio);
  wire(videoEl);

  const reloadIfKindChanged = () => {
    const s = get();
    const track = s.queue[s.index];
    if (!track) return;
    set({ videoNote: noteFor(track) });
    if (!loaded || loaded.id !== track.id) return;
    const wasPlaying = s.status === "playing" || s.status === "loading";
    if (needsClipLookup(track, s.preferVideo)) return load(s.index, { startAt: s.position, autoplay: wasPlaying });
    const kind = kindFor(track);
    if (loaded.kind === kind && (kind === "audio" || loaded.quality === s.quality)) return;
    load(s.index, { startAt: s.position, autoplay: wasPlaying });
  };

  return {
    queue: saved.queue ?? [],
    original: saved.original ?? null,
    index: saved.index ?? 0,
    status: saved.queue?.length ? "paused" : "idle",
    statusText: null,
    mediaKind: "audio",
    videoNote: null,
    videoAspect: 16 / 9,
    position: saved.position ?? 0,
    duration: saved.queue?.[saved.index ?? 0]?.duration ?? 0,
    buffered: 0,
    volume: saved.volume ?? 0.9,
    muted: saved.muted ?? false,
    shuffle: saved.shuffle ?? false,
    repeat: saved.repeat ?? "off",
    // Builds without video (Android) always play audio, whatever a backup or an old session says.
    preferVideo: capabilities.video && (saved.preferVideo ?? false),
    quality: saved.quality ?? "sd",
    autoRadio: saved.autoRadio ?? true,

    playList: (tracks, start = 0) => {
      if (!tracks.length) return;
      const first = tracks[start] ?? tracks[0];
      if (get().shuffle) {
        const rest = tracks.filter((_, i) => i !== start);
        set({ queue: [first, ...shuffled(rest)], original: tracks.slice() });
        load(0);
      } else {
        set({ queue: tracks.slice(), original: null });
        load(start);
      }
    },

    playTrack: (track) => {
      const s = get();
      const at = s.queue.findIndex((t) => t.id === track.id);
      if (at >= 0) return load(at);
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      load(insert);
    },

    playNext: (track) => {
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      toast(getT().player.playsNext(track.title));
    },

    addToQueue: (track) => {
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      set({ queue: [...s.queue, track], original: s.original ? [...s.original, track] : null });
      toast(getT().player.addedToQueue(track.title));
    },

    removeAt: (i) => {
      const s = get();
      if (i < 0 || i >= s.queue.length) return;
      const removed = s.queue[i];
      const queue = s.queue.filter((_, j) => j !== i);
      const original = s.original?.filter((t) => t !== removed) ?? null;
      if (i < s.index) return set({ queue, original, index: s.index - 1 });
      if (i > s.index) return set({ queue, original });
      // Removing the current track: move on to whatever takes its place.
      set({ queue, original });
      if (queue[i]) load(i, { autoplay: s.status === "playing" });
      else {
        activeMedia()?.pause();
        loaded = null;
        set({ index: Math.max(0, queue.length - 1), status: queue.length ? "paused" : "idle", position: 0 });
      }
    },

    jumpTo: (i) => load(i),

    clearUpcoming: () => {
      const s = get();
      const keep = s.queue.slice(0, s.index + 1);
      set({ queue: keep, original: s.original ? keep.slice() : null });
    },

    startRadio: async (track) => {
      manualRadio?.abort(); const controller = new AbortController(); manualRadio = controller; const mine = token;
      toast(getT().player.startingRadio(track.title));
      try {
        const related = await api.radio(track.id, controller.signal);
        if (controller.signal.aborted || mine !== token || sessionLost) return;
        get().playList([track, ...related.filter((t) => t.id !== track.id)], 0);
      } catch (e) {
        if (!controller.signal.aborted) toast((e as Error).message, "error");
      }
    },

    toggle: () => {
      const s = get();
      if (retryTimer || s.status === "loading" && resumeWanted) {
        completePreload.clear();
        cancelRetry(); resumeWanted = false; unlockPending = false; token++; activeMedia()?.pause(); loaded = null; set({ status: "paused", statusText: null }); return;
      }
      const track = s.queue[s.index];
      if (!track) return;
      const kind = kindFor(track);
      const stale =
        !loaded ||
        loaded.id !== track.id ||
        loaded.kind !== kind ||
        (kind === "video" && loaded.quality !== s.quality) ||
        !useSession.getState().offline && needsClipLookup(track, s.preferVideo);
      if (stale || s.status === "error") return load(s.index, { startAt: s.position });
      const media = mediaFor(kind);
      if (media.paused) { resumeWanted = true; play(media); }
      else { resumeWanted = false; unlockPending = false; media.pause(); }
    },

    next: () => {
      const s = get();
      if (s.index < s.queue.length - 1) return load(s.index + 1);
      if (s.repeat === "all" && s.queue.length) return load(0);
      if (s.autoRadio) void continueWithRadio();
    },

    prev: () => {
      const s = get();
      if (s.position > 3 || s.index === 0) return get().seek(0);
      load(s.index - 1);
    },

    seek: (seconds) => {
      const t = Math.max(0, Math.min(seconds, get().duration || seconds));
      set({ position: t });
      const media = activeMedia();
      const track = get().queue[get().index];
      if (!media || !track || loaded?.id !== track.id || media.readyState === 0) {
        pendingSeek = t;
        return;
      }
      media.currentTime = t;
    },

    setVolume: (v) => {
      const volume = Math.max(0, Math.min(1, v));
      const muted = volume === 0;
      normalization.setVolume(audio, volume, muted); normalization.setVolume(videoEl, volume, muted);
      set({ volume, muted });
    },

    toggleMute: () => {
      const muted = !get().muted;
      normalization.setVolume(audio, get().volume, muted); normalization.setVolume(videoEl, get().volume, muted);
      if (!muted && get().volume === 0) get().setVolume(0.6);
      else set({ muted });
    },

    toggleShuffle: () => {
      const s = get();
      const current = s.queue[s.index];
      if (!s.shuffle) {
        const rest = s.queue.filter((_, i) => i !== s.index);
        set({ shuffle: true, original: s.queue, queue: current ? [current, ...shuffled(rest)] : shuffled(rest), index: 0 });
        return;
      }
      const present = new Set(s.queue);
      const base = (s.original ?? s.queue).filter((t) => present.has(t));
      const extra = s.queue.filter((t) => !base.includes(t));
      const queue = [...base, ...extra];
      set({ shuffle: false, original: null, queue, index: Math.max(0, current ? queue.indexOf(current) : 0) });
    },

    cycleRepeat: () => {
      const order: Repeat[] = ["off", "all", "one"];
      set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
    },

    setPreferVideo: (on) => {
      if (on && (!capabilities.video || useSession.getState().offline)) return;
      set({ preferVideo: on });
      reloadIfKindChanged();
    },

    setQuality: (quality) => {
      qualityChanged = true;
      set({ quality });
      reloadIfKindChanged();
    },

    setAutoRadio: (autoRadio) => set({ autoRadio }),
    suspendOutput: () => {
      completePreload.clear(); if (activeBlob) { URL.revokeObjectURL(activeBlob); activeBlob = null; }
      cancelRetry(); resumeWanted = false; unlockPending = false; token++; loaded = null; pendingSeek = 0;
      radioJob?.controller.abort(); manualRadio?.abort();
      if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
      for (const media of [audio, videoEl]) {
        normalization.cancel(media);
        media.pause(); media.removeAttribute("src"); media.load();
      }
      set({ status: get().queue.length ? "paused" : "idle", statusText: null, buffered: 0 });
      syncPlaybackState();
    },
    resumeOutput: (snapshot) => {
      if (sessionLost || !playbackCanOutput()) return;
      const track = snapshot.queue[snapshot.index];
      const media = activeMedia();
      const autoplay = snapshot.status === "playing" || snapshot.status === "loading";
      resumeWanted = autoplay;
      if (track && media && loaded?.id === track.id && loaded.kind === kindFor(track) &&
        (loaded.kind === "audio" || loaded.quality === get().quality) && media.readyState > 0 && get().status !== "error") {
        cancelRetry();
        const difference = Math.abs(media.currentTime - snapshot.position);
        const drift = snapshot.repeat === "one" && snapshot.duration > 0
          ? Math.min(difference % snapshot.duration, snapshot.duration - difference % snapshot.duration) : difference;
        if (drift > 1.2 || !autoplay) { pendingSeek = 0; media.currentTime = snapshot.position; }
        set({ ...snapshot, position: media.currentTime, duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : snapshot.duration,
          status: autoplay ? media.paused || get().status === "loading" ? "loading" : "playing" : "paused", statusText: null });
        media.loop = snapshot.repeat === "one";
        if (autoplay && media.paused) play(media);
        else if (!autoplay) media.pause();
        setMetadata(track); syncPlaybackState(); return;
      }
      set({ ...snapshot, status: autoplay ? "loading" : "paused", statusText: null, buffered: 0 });
      if (snapshot.queue.length) load(snapshot.index, { startAt: snapshot.position, autoplay });
      else { get().suspendOutput(); set({ status: "idle" }); }
    },
    warmUpcoming: () => { warmRetries = 0; if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; } warmQueue(); },
    stopSession: () => {
      cancelRetry();
      completePreload.clear(); if (activeBlob) { URL.revokeObjectURL(activeBlob); activeBlob = null; }
      radioJob?.controller.abort(); manualRadio?.abort(); if (warmTimer) clearTimeout(warmTimer); token++; loaded = null; resumeWanted = false;
      for (const media of [audio, videoEl]) {
        normalization.cancel(media);
        media.pause(); media.removeAttribute("src"); media.load();
      }
      set({ queue: [], original: null, index: 0, status: "idle", statusText: null, position: 0, duration: 0, buffered: 0 });
      if ("mediaSession" in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; }
    },
  };
});

normalization.setVolume(audio, usePlayer.getState().volume, usePlayer.getState().muted);
normalization.setVolume(videoEl, usePlayer.getState().volume, usePlayer.getState().muted);
function normalizationPreference(state: ReturnType<typeof useSession.getState>) {
  if (state.preferences?.normalization) return state.preferences.normalization;
  if (!state.enabled) {
    try { return normalizationOf(localStorage.getItem("musike:normalization")); } catch {}
  }
  return "standard";
}
normalization.setMode(normalizationPreference(useSession.getState()));
useSession.subscribe?.(state => normalization.setMode(normalizationPreference(state)));

export const selectCurrent = (s: PlayerState): Track | null => s.queue[s.index] ?? null;

/** Whether the track can be shown as video (art tracks are audio with a still image). */

// Persistence: resume the same queue and position after a reload.

const writePlayer = playerWriter({ setItem: (key, value) => localStorage.setItem(key, value) }, STORAGE_KEY);
function persist() {
  if (sessionLost) return;
  try {
    writePlayer(usePlayer.getState());
  } catch {
    /* storage full or blocked */
  }
}
setInterval(persist, 4000);
// Queue edits (including optimistic/manual additions) refresh look-ahead without waiting for another playing event.
usePlayer.subscribe((state, previous) => {
  if (state.repeat !== previous.repeat) audio.loop = videoEl.loop = state.repeat === "one";
  if (state.status !== previous.status || state.index !== previous.index) syncPlaybackState();
  if (state.queue !== previous.queue || state.index !== previous.index || state.autoRadio !== previous.autoRadio || state.repeat !== previous.repeat)
    queueMicrotask(() => usePlayer.getState().warmUpcoming());
});
setInterval(() => { if (usePlayer.getState().status === "playing") usePlayer.getState().warmUpcoming(); }, 30_000);
if (api.playbackSettings) void api.playbackSettings().then((settings) => {
  lookahead = settings.lookahead;
  if (saved.quality === undefined && !qualityChanged && !sessionLost) usePlayer.setState({ quality: settings.videoQuality });
  usePlayer.getState().warmUpcoming();
}).catch(() => {});
addEventListener("musike:unauthorized", () => {
  if (sessionLost) return;
  persist(); sessionLost = true; usePlayer.getState().stopSession();
});
addEventListener("pagehide", persist);
function restorePlayback() {
  recordPlayback("page.resume"); void flushPlaybackEvents();
  const state = usePlayer.getState(); state.warmUpcoming();
  if (resumeWanted && document.visibilityState !== "hidden") { unlockPending = true;
    if (playbackCanOutput() && state.status === "playing") {
      const generation = token;
      normalization.start(mediaFor(state.mediaKind), () => generation === token && playbackCanOutput() && !sessionLost);
    }
  }
  if (resumeWanted && (state.status === "error" || recoveryPaused) && recoverableFailure(lastFailure) && !unlockRecoveryUsed && document.visibilityState !== "hidden") {
    unlockRecoveryUsed = true; unlockPending = false; recoveryCount = 0; recordPlayback("player.unlock_recovery"); if (recoveryPaused) { recoveryPaused = false; usePlayer.setState({ status: "error" }); }
    usePlayer.getState().toggle();
  }
}
document.addEventListener("visibilitychange", () => {
  recordPlayback(document.visibilityState === "hidden" ? "page.hidden" : "page.visible");
  if (document.visibilityState === "hidden") {
    normalization.finishDirectFade(audio);
    normalization.finishDirectFade(videoEl);
    persist(); usePlayer.getState().warmUpcoming(); void flushPlaybackEvents();
  } else restorePlayback();
});
addEventListener("online", restorePlayback);
addEventListener("pageshow", restorePlayback);
setInterval(() => {
  const state = usePlayer.getState();
  const media = loaded ? mediaFor(loaded.kind) : null;
  if (media?.ended && resumeWanted && playbackCanOutput()) media.dispatchEvent(new Event("timeupdate"));
  if (state.status === "loading" && state.statusText !== "fetchingRadio" && state.statusText !== "findingClip" && loaded && Date.now() - loadingAt > 8000) onLoadingDeadline();
  void flushPlaybackEvents();
}, 5000);

// Media Session: lock-screen, headset and notification controls.

function setMetadata(track: Track) {
  if (!("mediaSession" in navigator)) return;
  try { navigator.mediaSession.metadata = new MediaMetadata(mediaMetadata(track)); } catch { /* Browser may reject remote artwork. Audio remains usable. */ }
}

function syncPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  const s = usePlayer.getState();
  navigator.mediaSession.playbackState = mediaPlaybackState(s.status, resumeWanted, !!s.queue[s.index]);
  syncPositionState();
}

function syncPositionState() {
  const { duration, position } = usePlayer.getState();
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 });
  } catch {
    /* some browsers reject transient states */
  }
}

if ("mediaSession" in navigator) {
  registerMediaActions(navigator.mediaSession, () => usePlayer.getState());
  const restored = selectCurrent(usePlayer.getState());
  if (restored) setMetadata(restored);
}
audio.loop = videoEl.loop = usePlayer.getState().repeat === "one";

/** The player's status line in the current language, or null when there is nothing to say. */
export function useStatusText(): string | null {
  const note = usePlayer((s) => s.statusText);
  const t = useT();
  if (note === null) return null;
  return typeof note === "string" ? t.player.status[note] : note.error;
}

addEventListener("musike:track-deleted", event => {
  const id = (event as CustomEvent<string>).detail; const s = usePlayer.getState();
  const current = s.queue[s.index]; const queue = s.queue.filter(t => t.id !== id);
  if (current?.id === id) s.suspendOutput();
  completePreload.clear();
  usePlayer.setState({ queue, original: s.original?.filter(t => t.id !== id) ?? null,
    index: Math.max(0, queue.findIndex(t => t.id === current?.id)), ...(current?.id === id ? { status: "paused", position: 0, duration: 0 } : {}) });
});
