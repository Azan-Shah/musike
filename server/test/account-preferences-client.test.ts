import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("account preference browser controller applies server state without loops, sends field patches and rejects stale/offline changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-settings-client-"));
  const store = (initial: any) => {
    let state = initial; const listeners = new Set<any>();
    return { getState: () => state, setState: (patch: any) => { const old = state; state = { ...state, ...patch }; listeners.forEach(fn => fn(state, old)); }, subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); } };
  };
  const session = store({ enabled: true, user: { id: "owner" }, offline: false, preferences: { normalization: "standard", revision: 1, theme: "light", language: "en", appearance: { texture: false } } });
  const ui = store({ theme: "dark" }); ui.setState({ setTheme: (theme: string) => ui.setState({ theme }) });
  const language = store({ lang: "en" }); language.setState({ setLang: (lang: string) => language.setState({ lang }) });
  const appearance = store({ texture: true, accent: "#abcdef" }); appearance.setState({ set: (patch: any) => appearance.setState(patch) });
  const current = () => { const { set, ...value } = appearance.getState(); return value; };
  const calls: any[] = []; let server = structuredClone(session.getState().preferences); let hold: ((value: unknown) => void) | null = null; let held = false;
  const h = { session, ui, language, appearance, current, toast: () => {}, request: async (_url: string, patch: any) => {
    calls.push(patch); if (held) return new Promise(resolve => { hold = resolve; });
    server = { ...server, ...patch, revision: server.revision + 1 }; return server;
  } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__preferences"); Object.defineProperty(globalThis, "__preferences", { value: h, configurable: true });
  let stop = () => {};
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  try {
    const root = path.resolve("../web/src");
    const mocks = new Map([
      [path.join(root, "stores/session.ts"), "const h=globalThis.__preferences;export const useSession=h.session;export const accountRequest=h.request;"],
      [path.join(root, "stores/ui.ts"), "const h=globalThis.__preferences;export const useUi=h.ui;export const toast=h.toast;"],
      [path.join(root, "stores/appearance.ts"), "const h=globalThis.__preferences;export const useAppearance=h.appearance;export const currentAppearance=h.current;"],
      [path.join(root, "i18n/index.ts"), "const h=globalThis.__preferences;export const useI18n=h.language;export const getT=()=>({offline:{onlineRequired:'online',preferenceFailed:'failed'}});"],
    ]);
    const result = await build({ entryPoints: [path.join(root, "lib/accountPreferences.ts")], platform: "node", bundle: true, format: "esm", write: false, plugins: [{ name: "preferences", setup(p) {
      p.onLoad({ filter: /\.ts$/ }, args => mocks.has(args.path) ? { contents: mocks.get(args.path)!, loader: "ts" } : undefined);
    } }] });
    const file = path.join(dir, "preferences.mjs"); await writeFile(file, result.outputFiles[0]!.text);
    const { startAccountPreferences } = await import(pathToFileURL(file).href); stop = startAccountPreferences();
    await tick(); assert.equal(ui.getState().theme, "light"); assert.equal(appearance.getState().texture, false); assert.equal(calls.length, 0);
    ui.getState().setTheme("dark"); await tick(); assert.deepEqual(calls[0], { theme: "dark" }); assert.equal(session.getState().preferences.revision, 2);
    held = true; language.getState().setLang("pt-BR"); await tick();
    session.setState({ preferences: { ...server, revision: 10, theme: "light" } });
    hold!({ ...server, revision: 3, theme: "dark", language: "pt-BR" }); await tick(); assert.equal(ui.getState().theme, "light"); assert.equal(session.getState().preferences.revision, 10);
    session.setState({ offline: true }); const before = calls.length;
    ui.getState().setTheme("dark"); await tick(); assert.equal(ui.getState().theme, "light"); assert.equal(calls.length, before);
  } finally {
    stop(); if (descriptor) Object.defineProperty(globalThis, "__preferences", descriptor); else delete (globalThis as any).__preferences;
    await rm(dir, { recursive: true, force: true });
  }
});
