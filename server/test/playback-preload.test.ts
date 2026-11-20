import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackPreload } from "../../web/src/lib/playbackPreload.js";
test("complete next-track bytes survive loss of the network and are released after use", async () => {
  let calls = 0; const transport = (async () => { calls++; return new Response(new Uint8Array([1,2,3,4]), { headers: { "content-type": "audio/mp4" } }); }) as typeof fetch;
  const preload = new PlaybackPreload(transport); await preload.prepare("00000000001", "/api/stream/00000000001/audio", "fixture");
  await preload.prepare("00000000001", "/api/stream/00000000001/audio", "fixture"); assert.equal(calls, 1);
  const complete = preload.take("00000000001")!; assert.ok(complete.url.startsWith("blob:")); assert.deepEqual([...new Uint8Array(await (await fetch(complete.url)).arrayBuffer())], [1,2,3,4]);
  preload.clear(); URL.revokeObjectURL(complete.url); await assert.rejects(fetch(complete.url));
});
test("preload rejects HTML and oversized complete bodies and clears owner-scoped retained bytes", async () => {
  const html = new PlaybackPreload((async () => new Response("gateway", { headers: { "content-type": "text/html" } })) as typeof fetch);
  await html.prepare("00000000001", "/api/stream", "fixture"); assert.equal(html.take("00000000001"), null);
  const large = new PlaybackPreload((async () => new Response(new Uint8Array(5), { headers: { "content-type": "audio/mp4" } })) as typeof fetch, 4);
  await large.prepare("00000000001", "/api/stream", "fixture"); assert.equal(large.take("00000000001"), null);
  const retained = new PlaybackPreload((async () => new Response(new Uint8Array(4), { headers: { "content-type": "audio/mp4" } })) as typeof fetch);
  await retained.prepare("00000000001", "/api/stream", "fixture"); retained.clear(); assert.equal(retained.take("00000000001"), null);
});
test("persistent next-track hydration avoids network and stale hydration cannot replace a newer target", async () => {
  let calls = 0; let finish!: (blob: Blob) => void;
  const blob = new Blob(["saved"], { type: "audio/mp4" });
  const preload = new PlaybackPreload((async () => { calls++; throw new Error("offline"); }) as typeof fetch, 16 * 1024 * 1024, undefined, async () => blob);
  preload.retain("00000000001"); await preload.hydrate("00000000001", "fixture");
  const ready = preload.take("00000000001")!; assert.ok(ready); assert.equal(await (await fetch(ready.url)).text(), "saved"); URL.revokeObjectURL(ready.url); assert.equal(calls, 0);
  const stale = new PlaybackPreload(fetch, 16 * 1024 * 1024, undefined, () => new Promise(resolve => { finish = resolve; }));
  stale.retain("00000000001"); const pending = stale.hydrate("00000000001", "fixture");
  stale.retain("00000000002"); finish(blob); await pending;
  assert.equal(stale.take("00000000001"), null); assert.equal(stale.take("00000000002"), null);
});

test("preload retries transient failure after bounded backoff without changing the queue", async () => {
  const now = Date.now; let clock = now(); Date.now = () => clock;
  let calls = 0; let available = false;
  const preload = new PlaybackPreload((async () => { calls++; if (!available) throw new Error("offline");
    return new Response("complete", { headers: { "content-type": "audio/mp4", "content-length": "8" } }); }) as typeof fetch);
  try {
    for (let n = 0; n < 5; n++) await preload.prepare("00000000001", "/api/stream", "fixture");
    assert.equal(calls, 2); available = true; clock += 30_001;
    await preload.prepare("00000000001", "/api/stream", "fixture");
    const ready = preload.take("00000000001"); assert.ok(ready); assert.equal(calls, 3); URL.revokeObjectURL(ready.url);
  } finally { Date.now = now; preload.clear(); }
});

test("preload rejects a truncated body and tolerates unavailable optional storage", async () => {
  const short = new PlaybackPreload((async () => new Response("short", { headers: { "content-type": "audio/mp4", "content-length": "9" } })) as typeof fetch);
  await short.prepare("00000000001", "/api/stream", "fixture"); assert.equal(short.take("00000000001"), null);
  const fallback = new PlaybackPreload((async () => new Response("complete", { headers: { "content-type": "audio/mp4" } })) as typeof fetch, 16 * 1024 * 1024, undefined, async () => { throw new Error("Storage unavailable"); });
  fallback.retain("00000000001"); await fallback.hydrate("00000000001", "fixture");
  await fallback.prepare("00000000001", "/api/stream", "fixture");
  const ready = fallback.take("00000000001"); assert.ok(ready); URL.revokeObjectURL(ready.url);
});

test("clear and reselect of the same id cannot revive an older hydration", async () => {
  const jobs: ((blob: Blob) => void)[] = [];
  const preload = new PlaybackPreload(fetch, 16 * 1024 * 1024, undefined, () => new Promise(resolve => jobs.push(resolve)));
  preload.retain("00000000001"); const old = preload.hydrate("00000000001", "old");
  preload.clear(); preload.retain("00000000001"); const fresh = preload.hydrate("00000000001", "fresh");
  jobs[0]!(new Blob(["old"], { type: "audio/mp4" })); await old; assert.equal(preload.take("00000000001"), null);
  jobs[1]!(new Blob(["new"], { type: "audio/mp4" })); await fresh;
  const ready = preload.take("00000000001"); assert.equal(ready!.trace, "fresh"); URL.revokeObjectURL(ready!.url);
});
