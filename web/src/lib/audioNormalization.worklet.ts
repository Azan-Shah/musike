import { PeakLimiter } from "./audioNormalizationCore";
declare const sampleRate: number;
declare class AudioWorkletProcessor {}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class Normalizer extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "limit", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  private limiter = new PeakLimiter(sampleRate);

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    this.limiter.process(inputs[0] ?? [], outputs[0] ?? [], parameters.limit?.[0] === 1);
    return true;
  }
}

registerProcessor("musike-normalizer", Normalizer);
