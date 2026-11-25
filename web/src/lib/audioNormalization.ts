import workletUrl from "./audioNormalization.worklet?worker&url";
import { normalizationOf, trackGainDb, type LoudnessMeasurement, type Normalization } from "./audioNormalizationCore";
import { recordPlayback } from "./playbackDiagnostics";

const fadeSeconds = .025;
const linear = (db: number) => 10 ** (db / 20);

interface MediaLevel {
  volume: number;
  muted: boolean;
  measurement?: LoudnessMeasurement;
  armed: boolean;
  started: boolean;
  directFade: boolean;
  frame?: number;
}

interface Graph {
  track: GainNode;
  transition: GainNode;
  volume: GainNode;
  limit?: AudioParam;
}

function ramp(param: AudioParam, value: number, at: number, duration: number) {
  if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(at);
  else { param.cancelScheduledValues(at); param.setValueAtTime(param.value, at); }
  param.linearRampToValueAtTime(value, at + duration);
}

export class AudioNormalization {
  private context: AudioContext | null = null;
  private moduleReady = false;
  private graphs = new Map<HTMLMediaElement, Graph>();
  private levels = new Map<HTMLMediaElement, MediaLevel>();
  private mode: Normalization = "standard";
  private unavailable = false;

  private level(media: HTMLMediaElement) {
    let level = this.levels.get(media);
    if (!level) {
      level = { volume: media.volume, muted: media.muted, armed: false, started: false, directFade: false };
      this.levels.set(media, level);
    }
    return level;
  }

  private direct(media: HTMLMediaElement, level: MediaLevel, fade = level.directFade ? .25 : 1) {
    // Element volume is bounded to unity. The worklet graph can apply the measured boost.
    media.volume = level.volume * Math.min(1, linear(trackGainDb(this.mode, level.measurement))) * fade;
    media.muted = level.muted;
  }

  private setTrack(graph: Graph, level: MediaLevel, immediate: boolean) {
    const at = this.context!.currentTime;
    const gain = linear(trackGainDb(this.mode, level.measurement));
    if (immediate) {
      graph.track.gain.cancelScheduledValues(at);
      graph.track.gain.setValueAtTime(gain, at);
    } else ramp(graph.track.gain, gain, at, fadeSeconds);
    graph.limit?.setValueAtTime(this.mode !== "off" && !level.measurement ? 1 : 0, at);
  }

  setMode(value: Normalization) {
    const mode = normalizationOf(value);
    if (mode === this.mode) return;
    this.mode = mode;
    for (const [media, level] of this.levels) {
      const graph = this.graphs.get(media);
      if (graph) this.setTrack(graph, level, !level.started);
      else this.direct(media, level);
    }
  }

  setVolume(media: HTMLMediaElement, volume: number, muted: boolean) {
    const level = this.level(media);
    level.volume = volume;
    level.muted = muted;
    const graph = this.graphs.get(media);
    if (graph) ramp(graph.volume.gain, muted ? 0 : volume, this.context!.currentTime, .01);
    else this.direct(media, level);
  }

  /** Arm the exact source synchronously before replacing src. */
  arm(media: HTMLMediaElement, measurement?: LoudnessMeasurement) {
    const level = this.level(media);
    this.cancel(media);
    level.armed = true;
    level.measurement = measurement;
    const graph = this.graphs.get(media);
    if (graph) this.setTrack(graph, level, true);
    else {
      level.directFade = typeof requestAnimationFrame === "function" && document.visibilityState === "visible";
      this.direct(media, level);
    }
  }

  cancel(media: HTMLMediaElement) {
    const level = this.level(media);
    if (level.frame !== undefined) cancelAnimationFrame(level.frame);
    level.frame = undefined;
    level.directFade = false;
    level.armed = false;
    level.started = false;
    const graph = this.graphs.get(media);
    if (graph) {
      const at = this.context!.currentTime;
      graph.transition.gain.cancelScheduledValues(at);
      graph.transition.gain.setValueAtTime(0, at);
    }
  }

  finishDirectFade(media: HTMLMediaElement) {
    const level = this.levels.get(media);
    if (!level?.directFade) return;
    if (level.frame !== undefined) cancelAnimationFrame(level.frame);
    level.frame = undefined;
    level.directFade = false;
    this.direct(media, level);
  }

  playing(media: HTMLMediaElement) {
    const level = this.levels.get(media);
    if (!level?.armed || level.started) return;
    level.started = true;
    const graph = this.graphs.get(media);
    if (graph) {
      const at = this.context!.currentTime;
      graph.transition.gain.setValueAtTime(0, at);
      graph.transition.gain.linearRampToValueAtTime(1, at + fadeSeconds);
    } else if (level.directFade) {
      const start = performance.now();
      const frame = (now: number) => {
        const fraction = Math.min(1, Math.max(0, (now - start) / (fadeSeconds * 1000)));
        if (fraction === 1 || document.visibilityState !== "visible") return this.finishDirectFade(media);
        this.direct(media, level, .25 + .75 * fraction);
        level.frame = requestAnimationFrame(frame);
      };
      level.frame = requestAnimationFrame(frame);
    }
  }

  start(media: HTMLMediaElement, current: () => boolean) {
    if (typeof AudioContext === "undefined" || !current() || (this.unavailable && !this.graphs.has(media))) return;
    try {
      if (!this.context) {
        const context = new AudioContext({ latencyHint: "playback" });
        this.context = context;
        context.addEventListener("statechange", () => recordPlayback("normalization.state", { reason: context.state }));
        void context.audioWorklet.addModule(workletUrl).then(() => {
          this.moduleReady = true;
          this.attachAtBoundary(media, current);
        }).catch(() => {
          this.unavailable = true;
          void context.close().catch(() => {});
          recordPlayback("normalization.error", { reason: "initialization" });
        });
      }
      if (this.context.state !== "running") {
        void this.context.resume().then(() => this.attachAtBoundary(media, current)).catch(() => {
          recordPlayback("normalization.error", { reason: "resume" });
        });
      }
      this.attachAtBoundary(media, current);
    } catch {
      if (!this.graphs.size) {
        this.unavailable = true;
        void this.context?.close().catch(() => {});
      }
      recordPlayback("normalization.error", { reason: "initialization" });
    }
  }

  private attachAtBoundary(media: HTMLMediaElement, current: () => boolean) {
    const context = this.context;
    const level = this.levels.get(media);
    if (!current() || !context || context.state !== "running" || !this.moduleReady ||
      this.graphs.has(media) || !level?.armed || level.started || !media.paused) return;
    const track = context.createGain();
    const transition = context.createGain();
    const volume = context.createGain();
    transition.gain.value = 0;
    volume.gain.value = level.muted ? 0 : level.volume;
    let node: AudioWorkletNode | undefined;
    try { node = new AudioWorkletNode(context, "musike-normalizer", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }); }
    catch { recordPlayback("normalization.error", { reason: "processor_setup" }); }

    const graph = { track, transition, volume, limit: node?.parameters.get("limit") };
    this.setTrack(graph, level, true);
    transition.connect(volume);
    volume.connect(context.destination);
    if (node) { track.connect(node); node.connect(transition); }
    else track.connect(transition);

    try {
      const source = context.createMediaElementSource(media);
      source.connect(track);
      this.graphs.set(media, graph);
      level.directFade = false;
      media.volume = 1;
      media.muted = false;
    } catch {
      track.disconnect();
      node?.disconnect();
      transition.disconnect();
      volume.disconnect();
      recordPlayback("normalization.error", { reason: "source_setup" });
      return;
    }

    if (node) node.onprocessorerror = () => {
      track.disconnect();
      node.disconnect();
      track.connect(transition);
      graph.limit = undefined;
      recordPlayback("normalization.error", { reason: "processor" });
    };
  }
}
