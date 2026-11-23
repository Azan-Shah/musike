import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackWindow } from "../../web/src/lib/playbackWindow.ts";
import { nextDownloaded } from "../../web/src/lib/playbackFallback.ts";
import { beginPlaybackTrace, playbackEvents, recordPlayback } from "../../web/src/lib/playbackDiagnostics.ts";
const tick = async () => { for (let n = 0; n < 8; n++) await new Promise(r => setImmediate(r)); };
const id = (n: number) => String(n).padStart(11, "0");

test("three complete upcoming bodies prepare in order with one reader and survive advancement", async () => {
  const calls: string[] = []; let active = 0; let max = 0;
  const window = new PlaybackWindow((async url => { calls.push(String(url)); active++; max = Math.max(active, max); await tick(); active--;
    return new Response("four", { headers: { "content-type": "audio/mp4" } }); }) as typeof fetch, 4, () => {}, async () => null);
  try {
    window.retain([id(1), id(2), id(3), id(4)]);
    for (let n = 1; n <= 4; n++) window.prepare(id(n), id(n), "fixture");
    for (let n = 0; n < 15; n++) await tick();
    assert.deepEqual(calls, [id(1), id(2), id(3)]); assert.equal(max, 1);
    const first = window.take(id(1))!; assert.ok(first); URL.revokeObjectURL(first.url);
    window.retain([id(2), id(3), id(4)]);
    const second = window.take(id(2))!; const third = window.take(id(3))!;
    assert.ok(second); assert.ok(third); assert.equal(await third.blob.text(), "four"); URL.revokeObjectURL(second.url); URL.revokeObjectURL(third.url);
    assert.equal(calls.length, 3);
  } finally { window.clear(); }
});

test("replacing the preparation window aborts its active reader and cannot revive old bytes", async () => {
  let aborted = false;
  const window = new PlaybackWindow((async (url, options) => {
    if (String(url) === id(1)) return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }));
    return new Response("four", { headers: { "content-type": "audio/mp4" } });
  }) as typeof fetch, 4, () => {}, async () => null);
  try {
    window.retain([id(1), id(2)]); window.prepare(id(1), id(1), "old"); await tick();
    window.retain([id(3)]); window.prepare(id(3), id(3), "new"); await tick();
    assert.equal(aborted, true); assert.equal(window.take(id(1)), null);
    const ready = window.take(id(3)); assert.ok(ready); URL.revokeObjectURL(ready.url);
  } finally { window.clear(); }
});

test("downloaded fallback follows queue order, wraps once and stops when user intent changes", async () => {
  const queue = [1, 2, 3, 4].map(n => ({ id: id(n) })) as any;
  const body = new Blob(["complete"], { type: "audio/mp4" }); const reads: string[] = [];
  const read = async (key: string) => { reads.push(key); return key === id(4) ? body : null; };
  assert.equal((await nextDownloaded(queue, 0, false, read, () => true))?.index, 3);
  assert.deepEqual(reads, [id(2), id(3), id(4)]);
  assert.equal((await nextDownloaded(queue, 3, false, read, () => true)), null);
  assert.equal((await nextDownloaded(queue, 2, true, async key => key === id(1) ? body : null, () => true))?.index, 0);
  let valid = true;
  assert.equal(await nextDownloaded(queue, 0, true, async () => { valid = false; return body; }, () => valid), null);
});

test("successful preparation polls cannot evict ended and error evidence from the export", () => {
  const trace = beginPlaybackTrace(); recordPlayback("player.ended", { traceId: trace });
  for (let n = 0; n < 300; n++) {
    recordPlayback("http.start", { traceId: trace, operation: "queue.prepare" });
    recordPlayback("http.response", { traceId: trace, operation: "queue.prepare", status: 200 });
  }
  recordPlayback("http.error", { traceId: trace, operation: "queue.prepare", status: 502, reason: "server" });
  const entries = playbackEvents().filter(e => e.traceId === trace);
  assert.ok(entries.some(e => e.stage === "player.ended")); assert.ok(entries.some(e => e.status === 502));
  assert.ok(playbackEvents().length <= 200); assert.ok(entries.length < 10);
});
