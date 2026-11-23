import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("one reusable graph composes user volume/mute, carries modes, and bypasses processor failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "musike-graph-"));
  let contexts = 0; let sources = 0; const processors: any[] = []; const gains: any[] = [];
  class Node {
    connections: unknown[] = []; gain = { value: 1, setTargetAtTime: (v: number) => { this.gain.value = v; } };
    connect(target: unknown) { this.connections.push(target); } disconnect() { this.connections = []; }
  }
  class Context extends EventTarget {
    currentTime = 0; state = "running"; destination = new Node(); audioWorklet = { addModule: async () => {} };
    constructor() { super(); contexts++; } resume() { return Promise.resolve(); }
    createGain() { const node = new Node(); gains.push(node); return node; }
    createMediaElementSource() { sources++; return new Node(); }
  }
  class Processor extends Node { messages: any[] = []; port = { postMessage: (m: unknown) => this.messages.push(m) }; onprocessorerror?: () => void; constructor() { super(); processors.push(this); } }
  const globals = { AudioContext: Context, AudioWorkletNode: Processor };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const result = await build({ entryPoints: [path.resolve("../web/src/lib/audioNormalization.ts")], platform: "node", bundle: true, format: "esm", write: false,
      plugins: [{ name: "worklet-asset", setup(plugin) {
        plugin.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "fixture-worklet", namespace: "worklet" }));
        plugin.onLoad({ filter: /.*/, namespace: "worklet" }, () => ({ contents: 'export default "/fixture-worklet.js";' }));
      } }] });
    const file = path.join(directory, "normalization.mjs"); await writeFile(file, result.outputFiles[0]!.text);
    const { AudioNormalization } = await import(pathToFileURL(file).href);
    const normalizer = new AudioNormalization(); const media = { volume: .9, muted: false } as HTMLMediaElement;
    normalizer.setVolume(media, .4, false); normalizer.setMode("loud");
    await normalizer.start(media); await normalizer.start(media);
    assert.equal(contexts, 1); assert.equal(sources, 1); assert.equal(gains[0].gain.value, .4);
    assert.equal(media.volume, 1); assert.equal(media.muted, false);
    assert.ok(processors[0].messages.some((message: any) => message.mode === "loud"));
    normalizer.setVolume(media, .2, true); assert.equal(gains[0].gain.value, 0);
    normalizer.setVolume(media, .2, false); assert.equal(gains[0].gain.value, .2);
    normalizer.reset(media); assert.equal(processors[0].messages.at(-1).type, "reset");
    normalizer.setMode("quiet"); assert.equal(processors[0].messages.at(-1).mode, "quiet");
    const video = { volume: .7, muted: false } as HTMLMediaElement;
    normalizer.setVolume(video, .7, false); await normalizer.start(video);
    assert.equal(contexts, 1); assert.equal(sources, 2); assert.equal(gains[1].gain.value, .7);
    processors[0].onprocessorerror(); normalizer.setVolume(media, .3, false);
    assert.equal(gains[0].gain.value, .3, "processor bypass retains user volume instead of routing directly to maximum output");
    await normalizer.start(media); assert.equal(sources, 2);
    let closed = false;
    class Unavailable extends Context {
      audioWorklet = { addModule: async () => { throw new Error("Fixture unavailable asset"); } };
      close() { closed = true; return Promise.resolve(); }
    }
    Object.defineProperty(globalThis, "AudioContext", { value: Unavailable, configurable: true });
    const fallback = new AudioNormalization(); const direct = { volume: .6, muted: true } as HTMLMediaElement;
    await fallback.start(direct);
    assert.equal(sources, 2, "failed worklet setup must leave the media element on its original path");
    assert.equal(direct.volume, .6); assert.equal(direct.muted, true); assert.equal(closed, true);
  } finally {
    for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key];
    await rm(directory, { recursive: true, force: true });
  }
});
