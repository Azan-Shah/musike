export type Normalization = "quiet" | "standard" | "loud";
export const normalizationOf = (value: unknown): Normalization => value === "quiet" || value === "loud" ? value : "standard";
const targets = { quiet: -23, standard: -18, loud: -14 };

/** Streaming RMS level matching, silence gate and linked-channel peak protection.
 * Targets are dBFS RMS, not a claim of Spotify/EBU integrated-LUFS equivalence.
 * Runs on the audio rendering thread, independently of page animation/timer throttling.
 */
export class NormalizationCore {
  private energy = 0;
  private gain = 1;
  private limiter = 1;
  constructor(private rate: number, private mode: Normalization = "standard") {}
  setMode(mode: Normalization) { this.mode = normalizationOf(mode); }
  reset() { this.energy = 0; this.gain = 1; this.limiter = 1; }
  process(input: Float32Array[], output: Float32Array[]) {
    const samples = output[0]?.length ?? 0;
    const meter = Math.exp(-1 / (this.rate * .4));
    const release = Math.exp(-1 / (this.rate * .15));
    for (let i = 0; i < samples; i++) {
      let energy = 0; let peak = 0;
      for (const channel of input) { const x = Number.isFinite(channel[i]) ? channel[i]! : 0; energy += x * x; peak = Math.max(peak, Math.abs(x)); }
      energy /= Math.max(1, input.length);
      this.energy = meter * this.energy + (1 - meter) * energy;
      // Do not lift silence/noise floors, and limit amplification to +12 dB.
      const desired = this.energy > 1e-6 ? Math.min(4, Math.max(.063, 10 ** (targets[this.mode] / 20) / Math.sqrt(this.energy))) : Math.min(1, this.gain);
      const smoothing = Math.exp(-1 / (this.rate * (desired < this.gain ? .025 : 1.5)));
      this.gain = smoothing * this.gain + (1 - smoothing) * desired;
      const ceiling = 10 ** (-1 / 20);
      const protect = peak * this.gain > ceiling ? ceiling / (peak * this.gain) : 1;
      this.limiter = protect < this.limiter ? protect : release * this.limiter + (1 - release) * protect;
      for (let c = 0; c < output.length; c++) {
        const x = input[c]?.[i] ?? input[0]?.[i] ?? 0;
        output[c]![i] = Number.isFinite(x) ? x * this.gain * this.limiter : 0;
      }
    }
  }
}
