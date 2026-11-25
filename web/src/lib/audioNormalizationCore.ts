export type Normalization = "quiet" | "standard" | "loud" | "off";
export const normalizationOf = (value: unknown): Normalization =>
  value === "quiet" || value === "loud" || value === "off" ? value : "standard";
export interface LoudnessMeasurement { version: 1; integratedLufs: number; truePeakDbtp: number; }

const targets = { quiet: -23, standard: -18, loud: -14 };
const fallback = { quiet: -9, standard: -6, loud: -3 };

export function isLoudness(value: unknown): value is LoudnessMeasurement {
  const m = value as LoudnessMeasurement | null;
  return m?.version === 1 && Number.isFinite(m.integratedLufs) && m.integratedLufs >= -70 && m.integratedLufs <= 5 &&
    Number.isFinite(m.truePeakDbtp) && m.truePeakDbtp >= -100 && m.truePeakDbtp <= 20;
}

export function trackGainDb(mode: Normalization, measurement?: LoudnessMeasurement) {
  if (mode === "off") return 0;
  if (!isLoudness(measurement)) return fallback[mode];
  return Math.min(targets[mode] - measurement.integratedLufs, -1 - measurement.truePeakDbtp, 12);
}

const measurements = new WeakMap<Blob, LoudnessMeasurement>();

/** Attach metadata only to the complete body that carried it. */
export function rememberLoudness(blob: Blob, measurement: unknown) {
  if (isLoudness(measurement)) measurements.set(blob, measurement);
  return blob;
}

export const loudnessOf = (blob: Blob) => measurements.get(blob);

export function rememberResponseLoudness(blob: Blob, response: Response) {
  const header = response.status === 200 && response.headers.get("x-musike-loudness");
  if (!header || !/^1,-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(header)) return blob;
  const [, lufs, peak] = header.split(",");
  return rememberLoudness(blob, { version: 1, integratedLufs: Number(lufs), truePeakDbtp: Number(peak) });
}

const ceiling = 10 ** (-1 / 20);

/** The safety stage only acts on excessive peaks in an unmeasured rendition. */
export class PeakLimiter {
  private gain = 1;
  private release: number;
  constructor(rate: number) { this.release = Math.exp(-1 / (rate * .06)); }

  process(input: Float32Array[], output: Float32Array[], enabled: boolean) {
    const samples = output[0]?.length ?? 0;
    if (!enabled) this.gain = 1;
    for (let i = 0; i < samples; i++) {
      if (enabled) {
        let peak = 0;
        for (const channel of input) {
          const value = channel[i]!;
          if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
        }
        const allowed = peak > ceiling ? ceiling / peak : 1;
        this.gain = allowed < this.gain ? allowed : this.release * this.gain + (1 - this.release) * allowed;
      }
      for (let channel = 0; channel < output.length; channel++) {
        const value = input[channel]?.[i] ?? input[0]?.[i] ?? 0;
        output[channel]![i] = Number.isFinite(value) ? value * this.gain : 0;
      }
    }
  }
}
