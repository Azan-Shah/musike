import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("track deletion uses the shared scrollable Modal, cancel does nothing, and confirmation deletes once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-delete-dom-")); const root = path.resolve("../web/src");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid/favorites" });
  const h: any = { track: { id: "fixture0001", title: "Fixture song", artist: "Fixture", duration: 180, art: "", thumb: "", kind: "song" }, writes: [], purges: [] };
  const globals = { __deleteDom: h, window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    dispatchEvent: dom.window.dispatchEvent.bind(dom.window), CustomEvent: dom.window.CustomEvent };
  const old = new Map(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true });
  const mocks = new Map([
    ["i18n/index.ts", "import {en} from './en';export const useT=()=>en;"],
    ["hooks/useMediaQuery.ts", "export const useMediaQuery=()=>true;export const MD='';"],
    ["stores/ui.ts", "import {create} from 'zustand';const h=globalThis.__deleteDom;export const toast=()=>{};export const useUi=create(set=>({menu:{track:h.track,x:10,y:10},closeMenu:()=>set({menu:null}),openAddToPlaylist:()=>{}}));"],
    ["stores/library.ts", "import {create} from 'zustand';const h=globalThis.__deleteDom;export const useLibrary=create(()=>({favorites:[h.track],deleteTrack:async id=>h.writes.push(id)}));"],
    ["player/player.ts", "export const usePlayer={getState:()=>({})};"],
    ["lib/offlineDownloads.ts", "export const deleteLocalAudio=async id=>globalThis.__deleteDom.purges.push(id);"],
  ].map(([name, code]) => [path.join(root, name!), code!]));
  let stop = () => {};
  try {
    const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {TrackMenu} from './components/TrackMenu';import {useUi} from './stores/ui';const root=createRoot(document.getElementById('root'));export const render=()=>flushSync(()=>root.render(React.createElement(TrackMenu)));export const click=el=>flushSync(()=>el.click());export const open=()=>flushSync(()=>useUi.setState({menu:{track:globalThis.__deleteDom.track,x:10,y:10}}));export const stop=()=>flushSync(()=>root.unmount());`, loader: "tsx", resolveDir: root }, platform: "node", bundle: true, write: false, format: "esm", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "delete-ui", setup(p) {
      p.onLoad({ filter: /\.(ts|tsx)$/ }, args => mocks.has(args.path) ? { contents: mocks.get(args.path)!, loader: "tsx" } : undefined);
      p.onResolve({ filter: /^motion\/react$/ }, () => ({ path: "motion", namespace: "fixture" }));
      p.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `import React from 'react';const cache={};export const motion=new Proxy({}, {get:(_,tag)=>cache[tag]??=(React.forwardRef(({initial,animate,exit,transition,layout,whileHover,whileTap,...props},ref)=>React.createElement(tag,{...props,ref})))});export const AnimatePresence=({children})=>children;export const useReducedMotion=()=>true;`, loader: "jsx", resolveDir: root }));
    } }] });
    const file = path.join(dir, "delete.mjs"); await writeFile(file, result.outputFiles[0]!.text); const mod = await import(pathToFileURL(file).href); stop = mod.stop;
    const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
    mod.render(); mod.click(button("Delete from library"));
    let dialog = document.querySelector('[role="dialog"]')!; assert.ok(dialog); assert.ok(dialog.className.includes("max-h-[88dvh]"));
    assert.equal(h.writes.length, 0); mod.click(button("Cancel", dialog)); assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(h.writes.length, 0);
    mod.open(); mod.click(button("Delete from library")); dialog = document.querySelector('[role="dialog"]')!; mod.click(button("Delete", dialog));
    for (let n = 0; n < 8; n++) await new Promise(r => setImmediate(r));
    assert.deepEqual(h.writes, [h.track.id]); assert.deepEqual(h.purges, [h.track.id]);
  } finally {
    stop(); dom.window.close(); for (const [k, v] of old) if (v) Object.defineProperty(globalThis, k, v); else delete (globalThis as any)[k]; await rm(dir, { recursive: true, force: true });
  }
});
