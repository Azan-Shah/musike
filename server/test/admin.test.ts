import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";

const phone = (n: number) => `6012${String(n).padStart(7, "0")}`;
async function fixture(trustProxy = "") {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-admin-")); const previous = { ...config }; config.dataDir = dir;
  let now = Date.now(); const codes = new Map<string, string>();
  const app = await createApp({ enabled: true, adminPhone: phone(1), secret: "test-only-secret-".repeat(4), trustProxy,
    now: () => now, sendOtp: async (to, code) => { codes.set(to, code); } });
  const call = (url: string, cookie?: string, body?: unknown, method?: string, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") => app.inject({
    url, method: (method ?? (body === undefined ? "GET" : "POST")) as "GET" | "POST" | "PATCH", remoteAddress,
    headers: { "x-musike-request": "1", ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const login = async (n: number, invite?: string) => {
    now += 61_000;
    const request = (await call("/api/auth/request", undefined, { phone: phone(n), invite })).json();
    const response = await call("/api/auth/verify", undefined, { challengeId: request.challengeId, code: codes.get(phone(n)) });
    assert.equal(response.statusCode, 200, response.body);
    return { cookie: (response.headers["set-cookie"] as string[]).map((v) => v.split(";")[0]).join("; "), user: response.json().user };
  };
  return { app, call, login, dir, cleanup: async () => { await app.close(); Object.assign(config, previous); await rm(dir, { recursive: true, force: true }); } };
}

test("admin APIs enforce role, persist validated settings, and scope live clients to real sessions", async () => {
  const f = await fixture();
  try {
    const admin = await f.login(1);
    const invite = (await f.call("/api/admin/invites", admin.cookie, {})).json().code;
    const user = await f.login(2, invite);
    for (const url of ["/api/admin/settings", "/api/admin/users", "/api/admin/ops", "/api/system"]) assert.equal((await f.call(url, user.cookie)).statusCode, 403, url);
    assert.equal((await f.call("/api/system/ytdlp", user.cookie, {})).statusCode, 403);
    assert.equal((await f.call("/api/admin/settings", admin.cookie, { media: { lookahead: 5 } }, "PATCH")).statusCode, 200);
    assert.equal(config.lookahead, 5);
    assert.equal((await f.call("/api/admin/settings", admin.cookie)).json().media.lookahead, 5);
    assert.equal((await f.call("/api/admin/settings", admin.cookie, { media: { lookahead: -1 } }, "PATCH")).statusCode, 400);
    await f.call("/api/presence", admin.cookie, { clientId: "browser-admin" });
    await f.call("/api/presence", user.cookie, { clientId: "browser-user" });
    const ops = (await f.call("/api/admin/ops", admin.cookie)).json();
    assert.equal(ops.users, 2); assert.equal(ops.connectedUsers, 2); assert.equal(ops.clients.length, 2);
    assert.ok(ops.events.some((event: { action: string }) => event.action.startsWith("admin.")));
    assert.equal((await f.call(`/api/admin/users/${user.user.id}`, admin.cookie, { status: "disabled" }, "PATCH")).statusCode, 200);
    assert.equal((await f.call("/api/library", user.cookie)).statusCode, 401);
    assert.equal((await f.call("/api/admin/ops", admin.cookie)).json().clients.length, 1);
  } finally { await f.cleanup(); }
});

test("proxy matrix: direct socket, trusted XFF/CF, and untrusted spoofing resistance", async () => {
  for (const scenario of [
    { trust: "", remote: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.10", "cf-connecting-ip": "198.51.100.11" }, expected: "127.0.0.1" },
    { trust: "127.0.0.1/32", remote: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.10" }, expected: "198.51.100.10" },
    { trust: "127.0.0.1/32", remote: "127.0.0.1", headers: { "cf-connecting-ip": "198.51.100.11" }, expected: "198.51.100.11" },
    { trust: "127.0.0.1/32", remote: "192.0.2.20", headers: { "x-forwarded-for": "198.51.100.10", "cf-connecting-ip": "198.51.100.11" }, expected: "192.0.2.20" },
  ]) {
    const f = await fixture(scenario.trust);
    try {
      const admin = await f.login(1);
      await f.call("/api/presence", admin.cookie, { clientId: "proxy-browser" }, undefined, scenario.headers, scenario.remote);
      const ops = (await f.call("/api/admin/ops", admin.cookie, undefined, undefined, scenario.headers, scenario.remote)).json();
      assert.equal(ops.clients[0].ip, scenario.expected);
      assert.equal(ops.events[0].ip, scenario.expected);
    } finally { await f.cleanup(); }
  }
});


test("persisted instance settings and secure sessions survive an app restart", async () => {
  const f = await fixture(); let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const admin = await f.login(1);
    assert.equal((await f.call("/api/admin/settings", admin.cookie, { media: { lookahead: 6 }, otpExpiry: 240 }, "PATCH")).statusCode, 200);
    await f.app.close(); config.lookahead = 1;
    restarted = await createApp({ enabled: true, adminPhone: phone(1), secret: "test-only-secret-".repeat(4), trustProxy: "" });
    const response = await restarted.inject({ url: "/api/admin/settings", headers: { cookie: admin.cookie } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().media.lookahead, 6); assert.equal(response.json().otpExpiry, 240);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test("admin direct phone edit and hard deletion are role/CSRF guarded and revoke the target session", async () => {
  const f = await fixture();
  try {
    const admin = await f.login(1); const invitation = (await f.call("/api/admin/invites", admin.cookie, {})).json().code; const user = await f.login(2, invitation);
    assert.equal((await f.call(`/api/admin/users/${admin.user.id}`, user.cookie, { phone: phone(3) }, "PATCH")).statusCode, 403);
    assert.equal((await f.call(`/api/admin/users/${user.user.id}`, admin.cookie, { phone: phone(3) }, "PATCH", { origin: "https://wrong.example" })).statusCode, 403);
    const changed = await f.call(`/api/admin/users/${user.user.id}`, admin.cookie, { phone: phone(3) }, "PATCH"); assert.equal(changed.statusCode, 200, changed.body); assert.equal(changed.json().id, user.user.id);
    assert.equal((await f.call("/api/library", user.cookie)).statusCode, 401);
    const removed = await f.call(`/api/admin/users/${user.user.id}`, admin.cookie, { confirmation: user.user.id }, "DELETE"); assert.equal(removed.statusCode, 200, removed.body);
    assert.ok(!(await f.call("/api/admin/users", admin.cookie)).json().users.some((u: { id: string }) => u.id === user.user.id));
    for (const url of ["/api/social", "/api/jams", "/api/playlist-imports"]) assert.equal((await f.call(url)).statusCode, 401);
  } finally { await f.cleanup(); }
});

test("incoming share pagination uses the signed-in owner and returns only bounded summaries", async () => {
  const f = await fixture();
  try {
    const admin = await f.login(1);
    const invite = (await f.call("/api/admin/invites", admin.cookie, {})).json().code;
    const recipient = await f.login(2, invite);
    const code = (await f.call("/api/social", recipient.cookie)).json().code;
    assert.equal((await f.call("/api/social/friends", admin.cookie, { code })).statusCode, 200);
    assert.equal((await f.call(`/api/social/requests/${admin.user.id}`, recipient.cookie, { accept: true })).statusCode, 200);
    const group = (await f.call("/api/social/groups", admin.cookie, { name: "Fixture Group" })).json().id;
    assert.equal((await f.call(`/api/social/groups/${group}`, admin.cookie, { member: recipient.user.id }, "PATCH")).statusCode, 200);
    for (const name of ["First", "Second", "Third"]) {
      const playlist = (await f.call("/api/playlists", admin.cookie, { name })).json();
      assert.equal((await f.call("/api/social/shares", admin.cookie, { playlist: playlist.id, user: recipient.user.id, permission: "viewer" })).statusCode, 200);
      assert.equal((await f.call("/api/social/shares", admin.cookie, { playlist: playlist.id, group, permission: "editor" })).statusCode, 200);
    }
    assert.equal((await f.call("/api/social/shares?limit=2")).statusCode, 401);
    assert.equal((await f.call("/api/social/shares?limit=201", recipient.cookie)).statusCode, 400);
    const first = (await f.call("/api/social/shares?limit=2", recipient.cookie)).json();
    const last = (await f.call("/api/social/shares?limit=2&offset=2", recipient.cookie)).json();
    assert.equal(first.hasMore, true);
    assert.equal(last.hasMore, false);
    const shares = [...first.shares, ...last.shares];
    assert.equal(new Set(shares.map(s => s.id)).size, 3);
    assert.ok(shares.every(s => s.permission === "editor" && s.owner.id === admin.user.id && s.tracks === 0 && !("playlist" in s)));
    assert.deepEqual((await f.call("/api/social", recipient.cookie)).json().shares, shares);
    assert.deepEqual((await f.call(`/api/social/shares?user=${recipient.user.id}`, admin.cookie)).json().shares, []);
    await f.call(`/api/social/groups/${group}`, recipient.cookie, { member: recipient.user.id, remove: true }, "PATCH");
    assert.ok((await f.call("/api/social/shares", recipient.cookie)).json().shares.every(s => s.permission === "viewer"));
  } finally { await f.cleanup(); }
});
