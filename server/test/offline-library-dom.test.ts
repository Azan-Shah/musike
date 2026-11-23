import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("shared Library/TrackList show uncached metadata, block offline edits and queue online downloads without playing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-offline-dom-")); const root = path.resolve("../web/src");
  const track = (n: number) => ({ id: String(n).padStart(11, "0"), title: `Fixture ${n}`, artist: "Fixture", thumb: "", art: "", duration: 20, kind: "song" });
  const h: any = { tracks: [track(1), track(2)], played: [], downloads: [], writes: [], notices: [] };
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid/library" });
  const globals = { __domHarness: h, window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const mocks = new Map([
    ["i18n/index.ts", "import {en} from './en';export const getT=()=>en;export const useT=getT;export const getLang=()=>'en';"],
    ["stores/session.ts", "import {create} from 'zustand';export const useSession=create(()=>({offline:true,user:{id:'fixture-owner'}}));"],
    ["stores/library.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const useLibrary=create(()=>({status:'ready',favorites:h.tracks,history:h.tracks,playlists:[{id:'fixture-list',name:'Whole playlist',tracks:h.tracks}],toggleFavorite:t=>h.writes.push(t.id),createPlaylist:()=>h.writes.push('create')}));`],
    ["stores/offline.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const useOffline=create(()=>({summary:{entries:[{id:h.tracks[0].id,track:h.tracks[0]}]}}));`],
    ["stores/system.ts", "import {create} from 'zustand';export const useSystem=create(()=>({info:null}));export const needsAttention=()=>false;"],
    ["stores/appearance.ts", "import {create} from 'zustand';export const useAppearance=create(()=>({albumColumn:true,sidebarPlaylists:true}));"],
    ["stores/ui.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const toast=message=>h.notices.push(message);export const useUi=create(()=>({openMenu:()=>h.writes.push('menu')}));`],
    ["player/player.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const usePlayer=create(()=>({queue:[],index:0,status:'paused',playList:(tracks,index)=>h.played.push({tracks,index}),setPreferVideo:()=>{},setAutoRadio:()=>{}}));export const selectCurrent=s=>s.queue[s.index]??null;`],
    ["lib/offlineDownloads.ts", "export const downloadOfflineTrack=async t=>globalThis.__domHarness.downloads.push(t.id);"],
    ["lib/social.ts", "export const socialState=async()=>{throw new Error('Offline library must not request social data')};"],
    ["components/OfflineStorage.tsx", "export const OfflineStorage=()=>null;export const OfflinePlaylistButton=()=>null;"],
    ["components/PlaylistImportDialog.tsx", "export const PlaylistImportDialog=()=>null;"],
    ["components/Dialogs.tsx", "export const NamePlaylistDialog=()=>null;"],
  ].map(([file, contents]) => [path.join(root, file!), contents!]));
  let unmount: (() => void) | undefined;
  try {
    const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter} from 'react-router';import Library from './views/Library';import {TrackList} from './components/TrackList';export {useSession} from './stores/session';let root;export function render(list){root??=createRoot(document.getElementById('root'));flushSync(()=>root.render(React.createElement(MemoryRouter,null,list?React.createElement(TrackList,{tracks:globalThis.__domHarness.tracks,downloads:true}):React.createElement(Library,{downloads:true}))));}export function stop(){flushSync(()=>root.unmount());}`, loader: "tsx", resolveDir: root },
      bundle: true, platform: "node", format: "esm", write: false, define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "offline-ui-platform", setup(plugin) { plugin.onLoad({ filter: /\.(ts|tsx)$/ }, args => mocks.has(args.path) ? { contents: mocks.get(args.path)!, loader: "tsx" } : undefined); } }] });
    const file = path.join(dir, "offline-ui.mjs"); await writeFile(file, result.outputFiles[0]!.text); const mod = await import(pathToFileURL(file).href); unmount = mod.stop;
    mod.render(false); assert.ok(dom.window.document.body.textContent?.includes("Whole playlist"));
    assert.ok(dom.window.document.body.textContent?.includes("All downloaded audio"));
    assert.equal(dom.window.document.querySelector('button[aria-label="New playlist"]'), null);
    mod.render(true);
    const playButton = (title: string) => [...dom.window.document.querySelectorAll("button")].find(button => button.getAttribute("aria-label")?.includes(title))!;
    assert.ok(playButton("Fixture 2").closest("li")?.classList.contains("opacity-50"));
    playButton("Fixture 2").click(); assert.ok(h.notices.at(-1).includes("not downloaded")); assert.equal(h.downloads.length, 0);
    playButton("Fixture 1").click(); assert.equal(h.played.length, 1); assert.deepEqual(h.played[0].tracks.map((t: any) => t.id), [h.tracks[0].id]);
    assert.equal(h.writes.length, 0); assert.equal(dom.window.document.querySelector('button[aria-label*="favorites"]'), null);
    mod.useSession.setState({ offline: false }); await new Promise(resolve => setImmediate(resolve));
    playButton("Fixture 2").click(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.downloads, [h.tracks[1].id]); assert.equal(h.played.length, 1);
  } finally {
    unmount?.(); dom.window.close();
    for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key];
    await rm(dir, { recursive: true, force: true });
  }
});
