import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("real jam polling wraps repeat-one positions and rejects an older same-version response", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-jam-timeline-"));
  const root = path.resolve("../web/src"); const browser = new EventTarget();
  const h: any = { targets: [], timers: new Map(), timer: 0, control: null };
  const track = { id: "00000000001", title: "Fixture", artist: "Fixture", duration: 180, art: "", thumb: "", kind: "song" };
  h.view = { id: "room", owner: "alice", host: "alice", version: 3, updatedAt: 1_000_000, serverNow: 1_001_500,
    snapshot: { queue: [track], original: null, index: 0, position: 179, duration: 180, status: "playing", repeat: "one", shuffle: false, autoRadio: false }, members: [] };
  const values: Record<string, unknown> = {
    __jamTimeline: h, document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser),
    setTimeout: (fn: () => void) => { const id = ++h.timer; h.timers.set(id, fn); return id; },
    clearTimeout: (id: number) => h.timers.delete(id),
  };
  const descriptors = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const tick = async () => { for (let n = 0; n < 8; n++) await new Promise(r => setImmediate(r)); };
  let stop: (() => void) | undefined;
  try {
    const mocks = new Map([
      ["stores/session.ts", "export const accountRequest=async()=>structuredClone(globalThis.__jamTimeline.view);"],
      ["lib/playbackSync.ts", "const h=globalThis.__jamTimeline;export const alignJamPlayback=s=>h.targets.push(s);export const setJamControl=c=>h.control=c;export const claimPlayback=async()=>{};export const usePlaybackDevices={getState:()=>({view:{active:'output',deviceId:'output'}})};"],
      ["i18n/index.ts", "export const getT=()=>({features:{syncFailure:'Sync failed'}});"],
      ["stores/ui.ts", "export const toast=()=>{};"],
    ].map(([file, contents]) => [path.join(root, file!), contents!]));
    const built = await build({ entryPoints: [path.join(root, "lib/jams.ts")], bundle: true, write: false, format: "esm", platform: "node",
      plugins: [{ name: "jam-fixture", setup(p) { p.onLoad({ filter: /\.(ts|tsx)$/ }, args => mocks.has(args.path) ? { contents: mocks.get(args.path)!, loader: "ts" } : undefined); } }] });
    const file = path.join(dir, "jams.mjs"); await writeFile(file, built.outputFiles[0]!.text);
    const mod = await import(pathToFileURL(file).href); stop = mod.startJams(); await tick();
    assert.ok(Math.abs(h.targets.at(-1).position - .5) < .05);
    const poll = async () => { const [id, fn] = [...h.timers.entries()][0]!; h.timers.delete(id); fn(); await tick(); };
    h.view.serverNow += 180_000; await poll();
    assert.ok(Math.abs(h.targets.at(-1).position - .5) < .05);
    const count = h.targets.length; h.view.serverNow -= 1000; await poll();
    assert.equal(h.targets.length, count, "same-version older progress must not rewind the room");
    h.view.version++; h.view.serverNow += 1000; h.view.snapshot.status = "paused"; h.view.snapshot.position = 180; await poll();
    assert.equal(h.targets.at(-1).position, 180, "paused/explicit endpoint positions are not wrapped");
  } finally {
    stop?.();
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    await rm(dir, { recursive: true, force: true });
  }
});
