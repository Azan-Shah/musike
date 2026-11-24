import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { Database } from "../src/db.js";

test("normalization preferences default to Standard, sync between sessions, and stay owner-scoped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-preferences-")); const previous = config.dataDir; config.dataDir = dir;
  const codes = new Map<string, string>();
  const app = await createApp({ enabled: true, adminPhone: "60120000001", secret: "fixture-secret-".repeat(4), sendOtp: async (phone, code) => { codes.set(phone, code); } });
  const request = (url: string, method: "GET" | "POST" | "PATCH" = "GET", payload?: object, cookie?: string, marker = true) => app.inject({ url, method,
    headers: { ...(marker ? { "x-musike-request": "1" } : {}), ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
  const login = async (phone: string, invite?: string) => {
    const challenge = (await request("/api/auth/request", "POST", { phone, ...(invite ? { invite } : {}) })).json();
    const response = await request("/api/auth/verify", "POST", { challengeId: challenge.challengeId, code: codes.get(phone) });
    assert.equal(response.statusCode, 200);
    return { id: response.json().user.id, cookie: (response.cookies as { name: string; value: string }[]).map(c => `${c.name}=${c.value}`).join("; ") };
  };
  try {
    const first = await login("60120000001");
    const invite = (await request("/api/admin/invites", "POST", {}, first.cookie)).json().code;
    const second = await login("60120000002", invite);
    assert.equal((await request("/api/auth/me", "GET", undefined, first.cookie)).json().preferences.normalization, "standard");
    assert.equal((await request("/api/account/preferences", "PATCH", { normalization: "quiet" })).statusCode, 401);
    assert.equal((await request("/api/account/preferences", "PATCH", { normalization: "off" }, first.cookie)).statusCode, 400);
    assert.equal((await request("/api/account/preferences", "PATCH", { normalization: "loud", owner: second.id }, first.cookie)).statusCode, 200);
    assert.equal((await request("/api/account/preferences", "PATCH", { normalization: "loud" }, first.cookie, false)).statusCode, 403);
    const saved = await request("/api/account/preferences", "PATCH", { normalization: "loud" }, first.cookie);
    assert.deepEqual(saved.json(), { normalization: "loud", revision: 2 });
    assert.equal((await request("/api/auth/me", "GET", undefined, first.cookie)).json().preferences.normalization, "loud");
    const presence = await request("/api/presence", "POST", { clientId: "second-browser-document" }, first.cookie);
    assert.deepEqual(presence.json().preferences, saved.json());
    assert.equal((await request("/api/auth/me", "GET", undefined, second.cookie)).json().preferences.normalization, "standard");
    assert.equal((await request("/api/account/preferences", "PATCH", { normalization: "quiet" }, first.cookie)).json().revision, 3);
  } finally { await app.close(); config.dataDir = previous; await rm(dir, { recursive: true, force: true }); }
});

test("normalization migration backs up existing owners, is idempotent, indexed and cascades deletion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-pref-migration-")); const file = path.join(dir, "test.sqlite"); let db = await Database.open(file);
  try {
    await db.run("INSERT INTO users(id,phone,created_at) VALUES(?,?,?)", ["fixture-owner", "+60120000001", 1]);
    await db.run("DROP TABLE account_preferences"); await db.run("DELETE FROM migrations WHERE key='audio-normalization-v1'");
    await db.close(); db = await Database.open(file);
    const backups = (await readdir(dir)).filter(name => name.includes("before-audio-normalization")); assert.equal(backups.length, 1);
    assert.equal((await stat(path.join(dir, backups[0]!))).mode & 0o777, 0o600);
    assert.ok((await db.all("EXPLAIN QUERY PLAN SELECT normalization FROM account_preferences WHERE user_id=?", ["fixture-owner"])).some(row => /INDEX/.test(row.detail)));
    await db.run("INSERT INTO account_preferences(user_id,normalization) VALUES(?,?)", ["fixture-owner", "quiet"]);
    await db.close(); db = await Database.open(file);
    assert.equal((await db.get("SELECT normalization FROM account_preferences WHERE user_id=?", ["fixture-owner"]))?.normalization, "quiet");
    assert.equal((await readdir(dir)).filter(name => name.includes("before-audio-normalization")).length, 1);
    await db.run("DELETE FROM users WHERE id=?", ["fixture-owner"]);
    assert.equal((await db.get("SELECT count(*) AS n FROM account_preferences"))!.n, 0);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("performance indexes upgrade a populated DB once and serve the maintenance queries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "musike-performance-migration-"));
  const file = path.join(dir, "test.sqlite");
  const queries = [
    ["otps_cleanup_time", "DELETE FROM otps WHERE created_at<?", [10]],
    ["oauth_states_expiry", "DELETE FROM oauth_states WHERE expires_at<?", [10]],
    ["clients_session", "DELETE FROM clients WHERE session_hash IN (SELECT access_hash FROM sessions WHERE access_hash=? OR refresh_hash=?)", ["access", "refresh"]],
    ["import_runs_running", "SELECT id,user_id,report FROM import_runs WHERE status='running'", []],
  ] as const;
  let db = await Database.open(file);
  try {
    await db.run("INSERT INTO settings(key,value) VALUES('fixture','true')");
    for (const [index] of queries) await db.run(`DROP INDEX ${index}`);
    await db.run("DELETE FROM migrations WHERE key='query-performance-v1'");
    await db.close();
    db = await Database.open(file);
    for (const [index, sql, params] of queries) {
      const plan = await db.all(`EXPLAIN QUERY PLAN ${sql}`, [...params]);
      assert.ok(plan.some(step => step.detail.includes(index)), JSON.stringify(plan));
    }
    const backups = () => readdir(dir).then(names => names.filter(name => name.includes("before-query-performance")));
    const [backup] = await backups();
    assert.ok(backup);
    assert.equal((await stat(path.join(dir, backup))).mode & 0o777, 0o600);
    await db.close();
    db = await Database.open(file);
    assert.deepEqual(await backups(), [backup]);
    assert.equal((await db.get("SELECT value FROM settings WHERE key='fixture'"))?.value, "true");
    await db.batch([
      { sql: "INSERT INTO audit(at,action,ip) VALUES(1,'fixture','local')" },
      { sql: "WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM seq WHERE n<1005) INSERT INTO audit(at,action,ip) SELECT n,'fixture','local' FROM seq" },
      { sql: "DELETE FROM audit WHERE id < (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 999)" },
    ]);
    assert.deepEqual(await db.get("SELECT count(*) AS n,min(id) AS oldest FROM audit"), { n: 1000, oldest: 6 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
