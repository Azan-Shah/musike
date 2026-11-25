import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("a late worklet never attaches mid-song and the next source gets one fenced graph and fade", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "musike-graph-"));
  let contexts = 0;
  let sources = 0;
  let resumes = 0;
  let finishModule!: () => void;
  const processors: Processor[] = [];
  const gains: Node[] = [];
  class Param {
    value = 1;
    events: [string, number, number][] = [];
    setValueAtTime(value: number, at: number) { this.value = value; this.events.push(["set", value, at]); }
    linearRampToValueAtTime(value: number, at: number) { this.value = value; this.events.push(["ramp", value, at]); }
    cancelScheduledValues() {}
  }
  class Node {
    connections: unknown[] = [];
    gain = new Param();
    connect(target: unknown) { this.connections.push(target); }
    disconnect() { this.connections = []; }
  }
  class Context extends EventTarget {
    static last: Context;
    currentTime = 2;
    state = "running";
    destination = new Node();
    audioWorklet = { addModule: () => new Promise<void>(resolve => { finishModule = resolve; }) };
    constructor() { super(); contexts++; Context.last = this; }
    resume() { resumes++; this.state = "running"; return Promise.resolve(); }
    createGain() { const node = new Node(); gains.push(node); return node; }
    createMediaElementSource() { sources++; return new Node(); }
  }
  class Processor extends Node {
    parameters = new Map([["limit", new Param()]]);
    onprocessorerror?: () => void;
    constructor() { super(); processors.push(this); }
  }
  const globals = { AudioContext: Context, AudioWorkletNode: Processor };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const result = await build({ entryPoints: [path.resolve("../web/src/lib/audioNormalization.ts")], platform: "node", bundle: true, format: "esm", write: false,
      plugins: [{ name: "worklet-asset", setup(plugin) {
        plugin.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "fixture-worklet", namespace: "worklet" }));
        plugin.onLoad({ filter: /.*/, namespace: "worklet" }, () => ({ contents: 'export default "/fixture-worklet.js";' }));
      } }] });
    const file = path.join(directory, "normalization.mjs");
    await writeFile(file, result.outputFiles[0]!.text);
    const { AudioNormalization } = await import(pathToFileURL(file).href);
    const normalizer = new AudioNormalization();
    const media = { volume: .9, muted: false, paused: true };
    normalizer.setVolume(media, .4, false);
    normalizer.arm(media);
    normalizer.start(media, () => true);
    media.paused = false;
    finishModule();
    await Promise.resolve();
    assert.equal(sources, 0);
    normalizer.playing(media);

    media.paused = true;
    normalizer.arm(media, { version: 1, integratedLufs: -22, truePeakDbtp: -3 });
    normalizer.start(media, () => false);
    assert.equal(sources, 0, "a superseded player generation cannot attach");
    normalizer.start(media, () => true);
    normalizer.start(media, () => true);
    assert.equal(contexts, 1);
    assert.equal(sources, 1);
    assert.equal(gains[0]!.gain.value, 10 ** (2 / 20));
    assert.equal(gains[1]!.gain.value, 0);
    assert.equal(gains[2]!.gain.value, .4);
    assert.equal(media.volume, 1);
    Context.last.currentTime = 12;
    normalizer.playing(media);
    assert.deepEqual(gains[1]!.gain.events.slice(-2), [["set", 0, 12], ["ramp", 1, 12.025]]);

    normalizer.arm(media);
    assert.equal(processors[0]!.parameters.get("limit")!.value, 1);
    normalizer.setMode("off");
    assert.equal(processors[0]!.parameters.get("limit")!.value, 0);
    assert.equal(gains[0]!.gain.value, 1);
    normalizer.setVolume(media, .2, true);
    assert.equal(gains[2]!.gain.value, 0);
    processors[0]!.onprocessorerror!();
    assert.deepEqual(gains[0]!.connections, [gains[1]]);
    Context.last.state = "suspended";
    normalizer.start(media, () => true);
    assert.equal(resumes, 1, "attached bypass still resumes the context");
  } finally {
    for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key];
    await rm(directory, { recursive: true, force: true });
  }
});
