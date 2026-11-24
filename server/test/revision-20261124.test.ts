import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../src/accounts.js";
import { PlaybackSync } from "../src/playbackSync.js";
import { GoogleImport } from "../src/googleImport.js";
import { sourceTrack } from "../src/googleSource.js";
import { config } from "../src/config.js";
const track = (n: number) => ({ id: String(n).padStart(11, "0"), title: `Song ${n}`, artist: "Fixture artist", duration: 180, art: "", thumb: "", kind: "song" as const });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-revision-")); const old = config.dataDir; config.dataDir = dir;
  const a = await Accounts.open({ secret: "revision-test-only-secret-".repeat(3) });
  for (const [id, phone] of [["alice", "+60120000001"], ["bob", "+60120000002"]]) await a.db.run("INSERT INTO users(id,phone,created_at) VALUES(?,?,1)", [id!, phone!]);
  return { a, dir, close: async () => { await a.close(); config.dataDir = old; await rm(dir, { recursive: true, force: true }); } };
}

test("shared preference patches preserve unrelated fields and remain indexed, owner-scoped and durable", async () => {
  const f = await fixture();
  try {
    await f.a.setPreferences("alice", { theme: "light", appearance: { accent: "#abcdef", compactSidebar: true } });
    const [one, two] = await Promise.all([f.a.setPreferences("alice", { language: "pt-BR" }), f.a.setPreferences("alice", { appearance: { texture: false } })]);
    assert.ok(two.revision > one.revision);
    const p = await f.a.preferences("alice");
    assert.equal(p.theme, "light"); assert.equal(p.language, "pt-BR"); assert.equal(p.normalization, "standard");
    assert.deepEqual(p.appearance, { accent: "#abcdef", compactSidebar: true, texture: false });
    assert.deepEqual(await f.a.preferences("bob"), { normalization: "standard", revision: 0 });
    await assert.rejects(f.a.setPreferences("alice", { appearance: { volume: 1 } }), /Invalid/);
    await assert.rejects(f.a.setPreferences("alice", { theme: "made-up" }), /Invalid/);
    const plan = await f.a.db.all("EXPLAIN QUERY PLAN SELECT json FROM account_preferences WHERE user_id=?", ["alice"]);
    assert.ok(plan.some(row => /INDEX/.test(row.detail)));
    assert.ok(await f.a.db.get("SELECT key FROM migrations WHERE key='account-appearance-v1'"));
  } finally { await f.close(); }
});

test("installation re-registration keeps one device, fences old epochs and never inherits another output", async () => {
  const f = await fixture(); const sync = new PlaybackSync(f.a);
  try {
    const d = await sync.register("alice", "session", "stable-browser-installation", "Chrome Android", "document-one");
    const grant = await sync.act("alice", "session", d.deviceId, { type: "claim" });
    const snapshot = { queue: [track(1)], original: null, index: 0, position: 40, duration: 180, status: "playing", repeat: "off", shuffle: false, autoRadio: false };
    await sync.act("alice", "session", d.deviceId, { type: "snapshot", epoch: grant.epoch, seq: 1, snapshot });
    const refreshed = await sync.register("alice", "session", "stable-browser-installation", "Chrome Android", "document-two");
    assert.equal(refreshed.deviceId, d.deviceId); assert.equal(refreshed.devices.length, 1); assert.ok(refreshed.epoch > grant.epoch);
    assert.equal(refreshed.command?.action, "resume");
    await assert.rejects(sync.act("alice", "session", d.deviceId, { type: "snapshot", epoch: grant.epoch, seq: 2, snapshot }), /no longer owns/);
    const other = await sync.register("alice", "other-session", "other-installation", "Chrome Windows");
    await sync.act("alice", "other-session", other.deviceId, { type: "claim" });
    await sync.act("alice", "session", d.deviceId, { type: "snapshot", epoch: refreshed.epoch, seq: 1, snapshot: { ...snapshot, status: "paused" }, pausedForTransfer: true });
    const back = await sync.register("alice", "session", "stable-browser-installation", "Chrome Android", "document-three");
    assert.equal(back.active, other.deviceId); assert.equal(back.command, null);
  } finally { await sync.close(); await f.close(); }
});

test("closed SSE output is offline immediately and explicit takeover does not wait for a failed pause acknowledgement", async () => {
  const f = await fixture(); const sync = new PlaybackSync(f.a);
  try {
    const old = await sync.register("alice", "old", "old-installation", "Old");
    const next = await sync.register("alice", "new", "new-installation", "New");
    await sync.act("alice", "old", old.deviceId, { type: "claim" });
    const disconnect = await sync.subscribe("alice", "old", old.deviceId, () => {}); disconnect();
    const view = await sync.read("alice", "new", next.deviceId);
    assert.equal(view.devices.find(d => d.id === old.deviceId)?.online, false); assert.equal(view.takeoverAvailable, true);
    await assert.rejects(sync.act("alice", "new", next.deviceId, { type: "claim" }), /Take over/);
    const granted = await sync.act("alice", "new", next.deviceId, { type: "claim", takeover: true });
    assert.equal(granted.active, next.deviceId); assert.equal(granted.transfer, null);
  } finally { await sync.close(); await f.close(); }
});

test("deleteTrack cascades personal library references durably without touching another owner", async () => {
  const f = await fixture();
  try {
    const lib = f.a.library("alice"); await lib.addFavorite(track(1)); await lib.pushHistory(track(1));
    await lib.createPlaylist("One", [track(1), track(2)]); await lib.createPlaylist("Two", [track(1)]);
    await f.a.library("bob").addFavorite(track(1));
    const result = await lib.deleteTrack(track(1).id);
    assert.deepEqual(result.favorites, []); assert.deepEqual(result.history, []);
    assert.ok(result.playlists.every(p => p.tracks.every(t => t.id !== track(1).id)));
    const row = await f.a.db.get("SELECT json FROM libraries WHERE user_id=?", ["alice"]); assert.ok(!row!.json.includes(track(1).id));
    assert.equal((await f.a.library("bob").getLibrary()).favorites.length, 1);
  } finally { await f.close(); }
});

test("Google original-ID provider failure remains explained and exposes queued/resolving per-track progress", async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const service = new GoogleImport(f.a, { clientId: "fixture", clientSecret: "fixture", redirectUri: "https://fixture.invalid/callback",
    source: async () => ({ collections: [], likes: [track(1), track(2)], history: [], unavailable: [] }),
    original: async () => { await held; throw new Error("private provider text must never escape"); }, candidates: async () => [] });
  try {
    await f.a.db.run("INSERT INTO google_tokens(user_id,encrypted) VALUES(?,?)", ["alice", f.a.box.seal(JSON.stringify({ access_token: "fixture", refresh_token: "fixture", expires_at: Date.now() + 3600000 }), "google:alice")]);
    await service.start("alice");
    for (let i = 0; i < 100 && !(await service.status("alice")).report?.progress.active; i++) await new Promise(r => setTimeout(r, 5));
    const running = await service.status("alice");
    assert.equal(running.report?.progress.active?.status, "resolving"); assert.equal(running.report?.progress.waiting?.[0]?.status, "queued");
    release(); for (let i = 0; i < 100 && (await service.status("alice")).status === "running"; i++) await new Promise(r => setTimeout(r, 5));
    const done = await service.status("alice"); assert.equal(done.status, "partial"); assert.equal(done.report?.items.length, 2);
    assert.ok(done.report?.items.every(item => item.reason === "provider-unavailable" && item.status === "needs-review"));
    assert.ok(!JSON.stringify(done).includes("private provider text"));
  } finally { release(); await service.close(); await f.close(); }
});

test("Google source mapping retains endpoint-only video IDs and numeric durations", () => {
  assert.equal(sourceTrack({ endpoint: { payload: { videoId: track(1).id } }, title: "Song", artists: [{ name: "Artist" }], duration: 180 })?.duration, 180);
  assert.equal(sourceTrack({ navigation_endpoint: { payload: { videoId: track(2).id } }, title: "Song" })?.id, track(2).id);
  assert.match(sourceTrack({ title: "Metadata-only song", artists: [{ name: "Artist" }], duration: 180 })!.id, /^unresolved-/);
  assert.equal(sourceTrack(null), null);
});

test("appearance migration backs up populated normalization storage and preserves it across an idempotent reopen", async () => {
  const { Database } = await import("../src/db.js"); const { stat } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "musike-appearance-migration-")); const file = path.join(dir, "test.sqlite"); let db = await Database.open(file);
  try {
    await db.run("INSERT INTO users(id,phone,created_at) VALUES('owner','+60120000001',1)");
    await db.run("INSERT INTO account_preferences(user_id,normalization,revision) VALUES('owner','quiet',7)");
    await db.run("ALTER TABLE account_preferences DROP COLUMN json"); await db.run("DELETE FROM migrations WHERE key='account-appearance-v1'");
    await db.close(); db = await Database.open(file);
    const row = await db.get("SELECT * FROM account_preferences WHERE user_id='owner'"); assert.equal(row!.normalization, "quiet"); assert.equal(row!.revision, 7); assert.equal(row!.json, "{}");
    const backups = (await readdir(dir)).filter(n => n.includes("before-account-appearance")); assert.equal(backups.length, 1); assert.equal((await stat(path.join(dir, backups[0]!))).mode & 0o777, 0o600);
    await db.close(); db = await Database.open(file); assert.equal((await readdir(dir)).filter(n => n.includes("before-account-appearance")).length, 1);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
