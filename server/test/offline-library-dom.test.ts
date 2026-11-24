import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("offline browsing, online downloads, and lazy collection playback preserve track availability and order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-offline-dom-")); const root = path.resolve("../web/src");
  const track = (n: number) => ({ id: String(n).padStart(11, "0"), title: `Fixture ${n}`, artist: "Fixture", thumb: "", art: "", duration: 20, kind: "song" });
  const h: any = { tracks: [track(1), track(2)], played: [], downloads: [], writes: [], notices: [] };
  h.playlists = Array.from({ length: 75 }, (_, i) => ({ id: `fixture-list-${i + 1}`, name: `Whole playlist ${i + 1}`, tracks: h.tracks }));
  h.collection = { id: "remote-playlist", name: "Large collection", tracks: Array.from({ length: 125 }, (_, i) => track(i + 1)), createdAt: 1, updatedAt: 1 };
  h.detailReads = [];
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid/library" });
  const globals = { __domHarness: h, window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const mocks = new Map([
    ["i18n/index.ts", "import {en} from './en';export const getT=()=>en;export const useT=getT;export const getLang=()=>'en';"],
    ["stores/session.ts", "import {create} from 'zustand';export const useSession=create(()=>({offline:true,user:{id:'fixture-owner'}}));"],
    ["stores/library.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const useLibrary=create(()=>({status:'ready',favorites:h.tracks,favoriteIds:new Set(h.tracks.map(t=>t.id)),history:h.tracks,playlists:h.playlists.map(p=>({...p,trackCount:p.tracks.length,cover:p.tracks})),details:new Map(h.playlists.map(p=>[p.id,p])),loadPlaylist:async id=>{h.detailReads.push(id);useLibrary.setState({details:new Map([[id,h.collection]])});return h.collection;},toggleFavorite:t=>h.writes.push(t.id),createPlaylist:()=>h.writes.push('create')}));`],
    ["stores/offline.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const useOffline=create(()=>({summary:{entries:[{id:h.tracks[0].id,track:h.tracks[0]}]}}));`],
    ["stores/system.ts", "import {create} from 'zustand';export const useSystem=create(()=>({info:null}));export const needsAttention=()=>false;"],
    ["stores/appearance.ts", "import {create} from 'zustand';export const useAppearance=create(()=>({albumColumn:true,sidebarPlaylists:true}));"],
    ["stores/ui.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const toast=message=>h.notices.push(message);export const useUi=create(()=>({openMenu:()=>h.writes.push('menu')}));`],
    ["player/player.ts", `import {create} from 'zustand';const h=globalThis.__domHarness;export const usePlayer=create(()=>({queue:[],index:0,status:'paused',playList:(tracks,index)=>h.played.push({tracks,index}),setPreferVideo:()=>{},setAutoRadio:()=>{},toggle:()=>{}}));export const selectCurrent=s=>s.queue[s.index]??null;`],
    ["lib/offlineDownloads.ts", "export const downloadOfflineTrack=async t=>globalThis.__domHarness.downloads.push(t.id);"],
    ["lib/social.ts", "export const incomingShares=async()=>{throw new Error('Offline library must not request social data')};"],
    ["components/OfflineStorage.tsx", "export const OfflineStorage=()=>null;export const OfflinePlaylistButton=()=>null;"],
    ["components/PlaylistImportDialog.tsx", "export const PlaylistImportDialog=()=>null;"],
    ["components/Dialogs.tsx", "export const NamePlaylistDialog=()=>null;"],
    ["components/Modal.tsx", "export const Modal=()=>null;"],
  ].map(([file, contents]) => [path.join(root, file!), contents!]));
  let unmount: (() => void) | undefined;
  try {
    const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {MemoryRouter,Route,Routes} from 'react-router';import Collection from './views/Collection';import Library from './views/Library';import {TrackList} from './components/TrackList';export {useSession} from './stores/session';import {useLibrary} from './stores/library';let root;export function render(list){root??=createRoot(document.getElementById('root'));flushSync(()=>root.render(React.createElement(MemoryRouter,null,list?React.createElement(TrackList,{tracks:globalThis.__domHarness.tracks,downloads:true}):React.createElement(Library,{downloads:true}))));}export function renderCollection(){const h=globalThis.__domHarness;useLibrary.setState({playlists:[{...h.collection,trackCount:h.collection.tracks.length,cover:[]}],details:new Map()});flushSync(()=>root.render(React.createElement(MemoryRouter,{key:'collection',initialEntries:['/playlist/'+h.collection.id]},React.createElement(Routes,null,React.createElement(Route,{path:'/playlist/:id',element:React.createElement(Collection,{kind:'playlist'})})))));}export function stop(){flushSync(()=>root.unmount());}`, loader: "tsx", resolveDir: root },
      bundle: true, platform: "node", format: "esm", write: false, define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "offline-ui-platform", setup(plugin) { plugin.onLoad({ filter: /\.(ts|tsx)$/ }, args => mocks.has(args.path) ? { contents: mocks.get(args.path)!, loader: "tsx" } : undefined); } }] });
    const file = path.join(dir, "offline-ui.mjs"); await writeFile(file, result.outputFiles[0]!.text); const mod = await import(pathToFileURL(file).href); unmount = mod.stop;
    mod.render(false); assert.ok(dom.window.document.body.textContent?.includes("Whole playlist"));
    assert.ok(dom.window.document.body.textContent?.includes("All downloaded audio"));
    const cards = () => [...dom.window.document.querySelectorAll('a[href^="/playlist/"]')];
    assert.equal(cards().length, 36);
    assert.equal(cards()[0]?.getAttribute("href"), "/playlist/fixture-list-1");
    dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards().length, 36);
    assert.equal(cards()[0]?.getAttribute("href"), "/playlist/fixture-list-37");
    const search = dom.window.document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setInputValue.call(search, "  WHOLE PLAYLIST 74  ");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    for (let i = 0; i < 10 && cards().length !== 1; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards().length, 1);
    assert.equal(cards()[0]?.getAttribute("href"), "/playlist/fixture-list-74");
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
    mod.renderCollection();
    for (let i = 0; i < 20 && !playButton("Fixture 100"); i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.detailReads, [h.collection.id]);
    assert.ok(playButton("Fixture 100"));
    dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click();
    for (let i = 0; i < 20 && !playButton("Fixture 117"); i++) await new Promise(resolve => setImmediate(resolve));
    playButton("Fixture 117").click();
    assert.equal(h.played.at(-1).tracks.length, 125);
    assert.equal(h.played.at(-1).index, 116);
    assert.equal(h.played.at(-1).tracks[116].id, track(117).id);
  } finally {
    unmount?.(); dom.window.close();
    for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key];
    await rm(dir, { recursive: true, force: true });
  }
});
