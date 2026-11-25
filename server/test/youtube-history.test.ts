import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../src/accounts.js";
import { config } from "../src/config.js";
import { YouTubeHistory, type HistoryClientFactory, type WatchPing } from "../src/youtubeHistory.js";
import type { PlaybackSnapshot } from "../src/playbackSync.js";

const COOKIE = "SAPISID=fixture-sapisid-not-real; __Secure-3PAPISID=fixture-3p-not-real; SID=fixture-sid";
const song = (id: string, duration = 240) => ({ id, title: `Song ${id}`, artist: "Fixture artist", duration, thumb: "", art: "", kind: "song" as const });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-ythistory-")); const old = config.dataDir; config.dataDir = dir;
  const accounts = await Accounts.open({ adminPhone: "60120000001", secret: "youtube-history-fixture-".repeat(3) });
  const user = (await accounts.db.get("SELECT id FROM users"))!.id as string;
  const calls: { kind: "start" | "history" | "watchtime"; id: string; ping?: WatchPing }[] = []; const cookies: string[] = []; const logs: Record<string, unknown>[] = [];
  let clock = 1_000_000; let reject = false; let startReject = false;
  const factory: HistoryClientFactory = async (cookie) => {
    cookies.push(cookie); if (reject) throw new Error("rejected");
    return { account: async () => "Fixture Account",
      start: async (id) => { calls.push({ kind: "start", id }); if (startReject) throw new Error("start rejected"); return { history: async () => { calls.push({ kind: "history", id }); }, watchtime: async (ping) => { calls.push({ kind: "watchtime", id, ping }); } }; } };
  };
  const history = new YouTubeHistory(accounts, factory, (event) => logs.push(event), () => clock, true);
  const snap = (track: ReturnType<typeof song> | null, position: number, status: PlaybackSnapshot["status"] = "playing", repeat: PlaybackSnapshot["repeat"] = "off"): PlaybackSnapshot =>
    ({ queue: track ? [track] : [], original: null, index: 0, position, duration: track?.duration ?? 0, status, shuffle: false, repeat, autoRadio: false });
  /** Advances the clock and position together, as the player does while playing. */
  const at = async (seconds: number, snapshot: PlaybackSnapshot) => {
    clock = 1_000_000 + seconds * 1000;
    history.observe(user, snapshot);
    // The worker processes this query after observe's pending link lookup.
    await accounts.db.get("SELECT 1");
    await history.flush();
  };
  return { accounts, user, history, calls, cookies, logs, snap, at, setReject: (value: boolean) => { reject = value; }, setStartReject: (value: boolean) => { startReject = value; },
    cleanup: async () => { await history.close(); await accounts.close(); config.dataDir = old; await rm(dir, { recursive: true, force: true }); } };
}

test("connect validates cookies, stores them encrypted and reports the account", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.history.connect(f.user, "PREF=hl=en"), /signed-in YouTube cookies/);
    await assert.rejects(f.history.connect(f.user, "SAPISID=a\nSID=b"), /signed-in YouTube cookies/);
    f.setReject(true); await assert.rejects(f.history.connect(f.user, COOKIE), /didn't accept/); f.setReject(false);
    assert.deepEqual(await f.history.connect(f.user, `cookie: ${COOKIE}`), { connected: true, account: "Fixture Account" });
    assert.equal(f.cookies.at(-1), COOKIE);
    const row = await f.accounts.db.get("SELECT encrypted FROM youtube_history_connections WHERE user_id=?", [f.user]);
    assert.ok(row && !String(row.encrypted).includes("fixture-sapisid"));
    assert.deepEqual(await f.history.status(f.user), { configured: true, connected: true, account: "Fixture Account", last: null });
    assert.ok(!JSON.stringify(f.logs).includes("fixture-sapisid"));
    await f.history.disconnect(f.user); assert.equal((await f.history.status(f.user)).connected, false);
  } finally { await f.cleanup(); }
});

test("play, pause, resume and seek report history once and watch time for what was really heard", async () => {
  const f = await fixture(); const a = song("aaaaaaaaaaa");
  try {
    await f.history.connect(f.user, COOKIE);
    await f.at(0, f.snap(a, 0));
    assert.deepEqual(f.calls.map((c) => c.kind), ["start"]);
    await f.at(5, f.snap(a, 5)); assert.equal(f.calls.filter((c) => c.kind === "history").length, 0);
    await f.at(10, f.snap(a, 10)); assert.equal(f.calls.filter((c) => c.kind === "history").length, 1);
    for (let s = 15; s <= 40; s += 5) await f.at(s, f.snap(a, s));
    let pings = f.calls.filter((c) => c.kind === "watchtime");
    assert.equal(pings.length, 1); assert.deepEqual([pings[0]!.ping!.st, pings[0]!.ping!.et, pings[0]!.ping!.state, pings[0]!.ping!.final], [0, 40, "playing", false]);
    assert.equal(pings[0]!.ping!.length, 240);
    await f.at(50, f.snap(a, 50, "paused"));
    pings = f.calls.filter((c) => c.kind === "watchtime"); assert.deepEqual([pings[1]!.ping!.st, pings[1]!.ping!.et, pings[1]!.ping!.state], [40, 50, "paused"]);
    assert.equal((await f.history.status(f.user)).last?.title, a.title);
    await f.at(80, f.snap(a, 50, "paused")); assert.equal(f.calls.filter((c) => c.kind === "watchtime").length, 2);
    await f.at(90, f.snap(a, 50));
    await f.at(95, f.snap(a, 55));
    await f.at(96, f.snap(a, 150)); // seek forward
    pings = f.calls.filter((c) => c.kind === "watchtime"); assert.deepEqual([pings[2]!.ping!.st, pings[2]!.ping!.et], [50, 56]);
    await f.at(100, f.snap(song("bbbbbbbbbbb"), 0)); // next song
    pings = f.calls.filter((c) => c.kind === "watchtime" && c.id === a.id);
    assert.deepEqual([pings.at(-1)!.ping!.st, pings.at(-1)!.ping!.final], [150, true]); assert.ok(Math.abs(pings.at(-1)!.ping!.et - 154) < 0.01);
    assert.equal(f.calls.filter((c) => c.kind === "start").length, 2);
    assert.equal(f.calls.filter((c) => c.kind === "history").length, 1, "one history entry per play");
  } finally { await f.cleanup(); }
});

test("repeat-one loops count as separate plays", async () => {
  const f = await fixture(); const a = song("ccccccccccc", 30);
  try {
    await f.history.connect(f.user, COOKIE);
    for (let s = 0; s <= 28; s += 4) await f.at(s, f.snap(a, s, "playing", "one"));
    await f.at(31, f.snap(a, 1, "playing", "one")); // looped back to the start
    for (let s = 35; s <= 59; s += 4) await f.at(s, f.snap(a, s - 30, "playing", "one"));
    assert.equal(f.calls.filter((c) => c.kind === "start").length, 2);
    assert.equal(f.calls.filter((c) => c.kind === "history").length, 2);
    const final = f.calls.filter((c) => c.kind === "watchtime" && c.ping!.final);
    assert.equal(final.length, 1); assert.ok(final[0]!.ping!.et <= 30, "first play capped at the song length");
    assert.equal((await f.history.status(f.user)).last?.title, a.title);
  } finally { await f.cleanup(); }
});

test("quick skips are not added to history and unlinked users send nothing", async () => {
  const f = await fixture();
  try {
    await f.at(0, f.snap(song("ddddddddddd"), 0)); await f.at(5, f.snap(song("ddddddddddd"), 5));
    assert.equal(f.cookies.length, 0); assert.equal(f.calls.length, 0);
    await f.history.connect(f.user, COOKIE);
    await f.at(10, f.snap(song("eeeeeeeeeee"), 0)); await f.at(15, f.snap(song("eeeeeeeeeee"), 5));
    await f.at(16, f.snap(song("fffffffffff"), 0));
    assert.deepEqual(f.calls.map((c) => c.kind), ["start", "start"]);
  } finally { await f.cleanup(); }
});

test("a failed start drops the cached client so the next play self-heals", async () => {
  const f = await fixture(); const a = song("ggggggggggg");
  try {
    await f.history.connect(f.user, COOKIE);
    f.setStartReject(true);
    await f.at(0, f.snap(a, 0)); await f.at(5, f.snap(a, 5));
    assert.deepEqual(f.calls.filter((c) => c.kind === "start").map((c) => c.id), ["ggggggggggg"]);
    assert.equal(f.logs.filter((l) => l.event === "youtube_history.start_failed").length, 1);
    f.setStartReject(false);
    await f.at(70, f.snap(song("hhhhhhhhhhh"), 0)); // past the 60s retry backoff
    assert.deepEqual(f.calls.filter((c) => c.kind === "start").map((c) => c.id), ["ggggggggggg", "hhhhhhhhhhh"]);
    assert.equal(f.cookies.length, 3, "connect check, first client, then the poisoned client rebuilt fresh");
  } finally { await f.cleanup(); }
});
