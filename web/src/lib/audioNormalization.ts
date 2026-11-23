import workletUrl from "./audioNormalization.worklet?worker&url";
import { normalizationOf, type Normalization } from "./audioNormalizationCore";
import { recordPlayback } from "./playbackDiagnostics";

/** Never attach a media source until the worklet is ready and context is running. */
export class AudioNormalization {
  private context: AudioContext | null = null;
  private ready: Promise<void> | null = null;
  private nodes = new Map<HTMLMediaElement, { source: MediaElementAudioSourceNode; node: AudioWorkletNode; volume: GainNode }>();
  private levels = new Map<HTMLMediaElement, { volume: number; muted: boolean }>();
  private mode: Normalization = "standard";
  private failed = false;
  setMode(mode: Normalization) { this.mode = normalizationOf(mode); for (const { node } of this.nodes.values()) node.port.postMessage({ type: "mode", mode: this.mode }); }
  reset(media: HTMLMediaElement) { this.nodes.get(media)?.node.port.postMessage({ type: "reset" }); }
  setVolume(media: HTMLMediaElement, volume: number, muted: boolean) {
    this.levels.set(media, { volume, muted });
    const graph = this.nodes.get(media);
    if (graph) { media.volume = 1; media.muted = false; graph.volume.gain.setTargetAtTime(muted ? 0 : volume, this.context!.currentTime, .01); }
    else { media.volume = volume; media.muted = muted; }
  }
  async start(media: HTMLMediaElement) {
    if (this.failed || typeof AudioContext === "undefined") return;
    try {
      if (!this.context) {
        this.context = new AudioContext({ latencyHint: "playback" });
        this.context.addEventListener("statechange", () => recordPlayback("normalization.state", { reason: this.context!.state }));
        this.ready = this.context.audioWorklet.addModule(workletUrl);
      }
      // Invoke resume in the user-activation turn. Existing playback is not held waiting for it.
      const resumed = this.context.resume(); await Promise.all([this.ready, resumed]);
      if (this.context.state !== "running" || this.nodes.has(media)) return;
      const node = new AudioWorkletNode(this.context, "musike-normalizer", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.postMessage({ type: "mode", mode: this.mode });
      const volume = this.context.createGain();
      const level = this.levels.get(media) ?? { volume: media.volume, muted: media.muted };
      volume.gain.value = level.muted ? 0 : level.volume;
      volume.connect(this.context.destination); node.connect(volume);
      const source = this.context.createMediaElementSource(media);
      this.nodes.set(media, { source, node, volume }); source.connect(node);
      media.volume = 1; media.muted = false;
      node.onprocessorerror = () => {
        // An attached element cannot return to its original path. Bypass a failed processor.
        source.disconnect(); source.connect(volume);
        this.failed = true; recordPlayback("normalization.error", { reason: "processor" });
      };
    } catch {
      const graph = this.nodes.get(media);
      if (graph) { graph.source.disconnect(); graph.source.connect(graph.volume); media.volume = 1; media.muted = false; }
      else if (!this.nodes.size) void this.context?.close().catch(() => {});
      this.failed = true; recordPlayback("normalization.error", { reason: "initialization" });
    }
  }
}
