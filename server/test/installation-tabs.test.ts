import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Accounts } from "../src/accounts.js";
import { PlaybackSync } from "../src/playbackSync.js";
import { config } from "../src/config.js";

test("two browser tabs share one installation and only the lock holder outputs, including refresh handover", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-tabs-")); const previous = config.dataDir; config.dataDir = dir;
  const accounts = await Accounts.open({ secret: "tabs-test-only-".repeat(4) });
  await accounts.db.run("INSERT INTO users(id,phone,created_at) VALUES('owner','+60120000001',1)");
  const sync = new PlaybackSync(accounts); const stops: (() => void)[] = [];
  const values = new Map<string, string>([["musike:user", "owner"]]);
  const browser = new EventTarget(); const locked = new Map<string, Promise<void>>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const channels: Set<any> = new Set();
  class Channel {
    onmessage?: (event: { data: any }) => void; constructor(public name: string) { channels.add(this); }
    postMessage(data: unknown) { for (const c of channels) if (c !== this && c.name === this.name) queueMicrotask(() => { if (channels.has(c)) c.onmessage?.({ data: structuredClone(data) }); }); }
    close() { channels.delete(this); }
  }
  const until = async (check: () => boolean) => { for (let n = 0; n < 400; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("Tab condition did not become true"); };
  let registrations = 0;
  const request = async (url: string, body: any) => {
    if (url.endsWith("/devices")) { registrations++; return sync.register("owner", "session", body.clientId, body.name, body.instanceId); }
    return sync.act("owner", "session", body.deviceId, body);
  };
  const globals = { sessionStorage: storage, localStorage: storage, BroadcastChannel: Channel,
    navigator: { userAgent: "Chrome/100 Windows", locks: { request: async (key: string, options: any, run: () => Promise<void>) => {
      const old = locked.get(key) ?? Promise.resolve(); let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; }); locked.set(key, next);
      await old; try { if (options.signal.aborted) throw new DOMException("Aborted", "AbortError"); await run(); } finally { release(); }
    } } },
    addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser), dispatchEvent: browser.dispatchEvent.bind(browser),
    __tabs: { request },
    fetch: async (url: string, init: RequestInit) => {
      if (init.method === "POST") { await request(url, JSON.parse(init.body as string)); return new Response("{}"); }
      const id = new URL(url, "https://fixture.invalid").searchParams.get("deviceId")!; let dispose = () => {}; let closed = false;
      return new Response(new ReadableStream({ async start(controller) {
        dispose = await sync.subscribe("owner", "session", id, view => { if (!closed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(view)}\n\n`)); });
        const close = () => { if (closed) return; closed = true; dispose(); controller.close(); };
        init.signal?.addEventListener("abort", close, { once: true });
      }, cancel() { closed = true; dispose(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const root = path.resolve("../web/src");
    const mocks = new Map([
      [path.join(root, "stores/session.ts"), "const h=globalThis.__tabs; export const accountRequest=(url,body)=>h.request(url,body);"],
      [path.join(root, "lib/offlineDownloads.ts"), "export const rememberOutput=async()=>{};"],
      [path.join(root, "i18n/index.ts"), "export const getT=()=>({features:{syncFailure:'failed',syncConnecting:'connecting'}});"],
      [path.join(root, "stores/ui.ts"), "export const toast=()=>{};"],
    ]);
    const built = await build({ entryPoints: [path.join(root, "lib/playbackSync.ts")], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "tabs", setup(plugin) {
      plugin.onLoad({ filter: /\.ts$/ }, args => mocks.has(args.path) ? { contents: mocks.get(args.path)!, loader: "ts" } : undefined);
    } }] });
    const clients: any[] = [];
    for (const name of ["first", "second"]) {
      const file = path.join(dir, `${name}.mjs`); await writeFile(file, built.outputFiles[0]!.text); const mod = await import(pathToFileURL(file).href);
      let state: any = { queue: [], original: null, index: 0, position: 0, duration: 180, status: "paused", shuffle: false, repeat: "off", autoRadio: false };
      let audible = false; const listeners = new Set<any>();
      const store: any = { getState: () => state, setState: (patch: object) => { const old = state; state = { ...state, ...patch }; listeners.forEach(fn => fn(state, old)); }, subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); } };
      const noop = () => {};
      state = { ...state, suspendOutput: () => { audible = false; store.setState({ status: "paused" }); }, resumeOutput: (snapshot: object) => { audible = true; store.setState({ ...snapshot, status: "playing" }); },
        playList: (queue: any[]) => { audible = true; store.setState({ queue, status: "playing" }); }, seek: (position: number) => store.setState({ position }),
        playTrack: noop, playNext: noop, addToQueue: noop, removeAt: noop, jumpTo: noop, clearUpcoming: noop, startRadio: noop, toggle: noop, next: noop, prev: noop, toggleShuffle: noop, cycleRepeat: noop, setAutoRadio: noop };
      const stop = mod.startPlaybackSync(store); stops.push(stop); clients.push({ mod, store, audible: () => audible, stop });
    }
    await until(() => clients[0].mod.usePlaybackDevices.getState().connected);
    clients[0].store.getState().playList([{ id: "fixture0001", title: "Song", artist: "Artist", duration: 180, kind: "song", art: "", thumb: "" }]);
    await until(() => clients[1].store.getState().queue.length === 1);
    assert.equal(registrations, 1); assert.equal(clients[0].audible(), true); assert.equal(clients[1].audible(), false);
    clients[1].store.getState().seek(60); await until(() => clients[0].store.getState().position === 60);
    const before = clients[0].mod.usePlaybackDevices.getState().view;
    clients[0].stop(); await until(() => registrations === 2 && clients[1].audible());
    const after = clients[1].mod.usePlaybackDevices.getState().view;
    assert.equal(before.deviceId, after.deviceId); assert.equal(after.devices.length, 1); assert.ok(after.epoch > before.epoch);
    assert.equal(clients[0].audible(), false);
  } finally {
    stops.forEach(stop => stop()); await new Promise(r => setTimeout(r, 20));
    await sync.close(); await accounts.close(); config.dataDir = previous;
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    await rm(dir, { recursive: true, force: true });
  }
});
