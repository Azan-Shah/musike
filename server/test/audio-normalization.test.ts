import assert from "node:assert/strict";
import { test } from "node:test";
import { loudnessOf, normalizationOf, PeakLimiter, rememberResponseLoudness, trackGainDb } from "../../web/src/lib/audioNormalizationCore.ts";
import { parseLoudness } from "../src/mediaLoudness.js";

test("fixed gain preserves quiet and loud passages and respects measured peak headroom", () => {
  const measurement = { version: 1, integratedLufs: -28, truePeakDbtp: -4 } as const;
  assert.equal(trackGainDb("standard", measurement), 3);
  assert.equal(trackGainDb("quiet", { ...measurement, integratedLufs: -60, truePeakDbtp: -28 }), 12);
  assert.equal(trackGainDb("standard", { ...measurement, integratedLufs: -10 }), -8);
  assert.deepEqual(["quiet", "standard", "loud", "off"].map(mode => trackGainDb(normalizationOf(mode))), [-9, -6, -3, 0]);
  assert.equal(trackGainDb("off", measurement), 0);
  assert.equal(normalizationOf(undefined), "standard");

  const limiter = new PeakLimiter(48000);
  const gain = 10 ** (trackGainDb("standard", measurement) / 20);
  const input = Float32Array.from([.01, .01, .7, .3, .01], sample => sample * gain);
  const output = new Float32Array(input.length);
  limiter.process([input], [output], false);
  assert.deepEqual(output, input);
});

test("unknown-rendition safety limits peaks in sync across channels and Off passes the input", () => {
  const limiter = new PeakLimiter(48000);
  const left = Float32Array.from([1, -1, NaN, Infinity, .2]);
  const right = Float32Array.from([.5, -.5, NaN, Infinity, .1]);
  const a = new Float32Array(5);
  const b = new Float32Array(5);
  limiter.process([left, right], [a, b], true);
  assert.ok([...a, ...b].every(x => Number.isFinite(x) && Math.abs(x) <= 10 ** (-1 / 20) + 1e-6));
  assert.ok(Math.abs(a[0]! / b[0]! - 2) < .001);
  limiter.process([left, right], [a, b], false);
  assert.deepEqual([...a], [1, -1, 0, 0, left[4]]);
});

test("server stats and browser metadata accept finite values bound to a complete response", () => {
  const measurement = parseLoudness('log\n{ "input_i": "-22.60", "input_tp": "-4.25" }\n');
  assert.deepEqual(measurement, { version: 1, integratedLufs: -22.6, truePeakDbtp: -4.25 });
  assert.equal(parseLoudness('{ "input_i": "-inf", "input_tp": "-inf" }'), undefined);
  const measured = new Blob(["complete"], { type: "audio/webm" });
  rememberResponseLoudness(measured, new Response(null, { headers: { "x-musike-loudness": "1,-22.6,-4.25" } }));
  assert.deepEqual(loudnessOf(measured), measurement);
  const partial = new Blob(["part"], { type: "audio/webm" });
  rememberResponseLoudness(partial, new Response(null, { status: 206, headers: { "x-musike-loudness": "1,-22.6,-4.25" } }));
  assert.equal(loudnessOf(partial), undefined);
});
