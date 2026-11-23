import assert from "node:assert/strict";
import { test } from "node:test";
import { NormalizationCore, normalizationOf, type Normalization } from "../../web/src/lib/audioNormalizationCore.ts";

function level(amplitude: number, mode: Normalization) {
  const core = new NormalizationCore(48000, mode); let sum = 0; let count = 0; let peak = 0;
  for (let block = 0; block < 4000; block++) {
    const input = Float32Array.from({ length: 128 }, (_, i) => amplitude * Math.sin((block * 128 + i) * 2 * Math.PI * 440 / 48000));
    const output = new Float32Array(128); core.process([input], [output]);
    for (const x of output) { assert.ok(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x)); if (block > 3500) { sum += x * x; count++; } }
  }
  return { rms: Math.sqrt(sum / count), peak };
}
test("normalization actually matches different input levels and offers three ordered targets", () => {
  const quietInput = level(.05, "standard"); const loudInput = level(.5, "standard");
  assert.ok(Math.abs(20 * Math.log10(quietInput.rms / loudInput.rms)) < 1.5);
  const quiet = level(.5, "quiet"); const loud = level(.5, "loud");
  assert.ok(quiet.rms < loudInput.rms && loudInput.rms < loud.rms);
  assert.equal(normalizationOf("off"), "standard"); assert.equal(normalizationOf(undefined), "standard");
});
test("peak protection, silence, nonfinite samples, stereo linkage and reset stay bounded", () => {
  const core = new NormalizationCore(48000, "loud");
  const left = Float32Array.from([100, -100, NaN, Infinity, .2]); const right = Float32Array.from([50, -50, NaN, Infinity, .1]);
  const a = new Float32Array(5); const b = new Float32Array(5); core.process([left, right], [a, b]);
  assert.ok([...a, ...b].every(x => Number.isFinite(x) && Math.abs(x) <= 10 ** (-1 / 20) + 1e-6));
  assert.ok(Math.abs(a[0]! / b[0]! - 2) < .001);
  core.reset(); core.setMode("quiet"); core.process([new Float32Array(5)], [a]); assert.deepEqual([...a], [0,0,0,0,0]);
});
