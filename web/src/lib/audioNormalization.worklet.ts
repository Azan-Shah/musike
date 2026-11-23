import { NormalizationCore, normalizationOf } from "./audioNormalizationCore";
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class Normalizer extends AudioWorkletProcessor {
  private core = new NormalizationCore(sampleRate);
  constructor() {
    super();
    this.port.onmessage = event => {
      if (event.data?.type === "reset") this.core.reset();
      else if (event.data?.type === "mode") this.core.setMode(normalizationOf(event.data.mode));
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    this.core.process(inputs[0] ?? [], outputs[0] ?? []); return true;
  }
}
registerProcessor("musike-normalizer", Normalizer);
