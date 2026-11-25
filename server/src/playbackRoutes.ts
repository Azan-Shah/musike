import type { FastifyInstance } from "fastify";
import type { Accounts } from "./accounts.js";
import { fail } from "./accounts.js";
import { PlaybackSync, type SyncView } from "./playbackSync.js";

export function registerPlayback(app: FastifyInstance, accounts: Accounts | null) {
  if (!accounts) return null;
  const sync = new PlaybackSync(accounts); const streams = new Set<() => void>();
  const owner = (req: import("fastify").FastifyRequest) => {
    if (!req.musikeUser || !req.musikeSession) throw fail(401, "Login required");
    return { user: req.musikeUser.id, session: req.musikeSession };
  };
  app.post("/api/playback/devices", { bodyLimit: 1024 }, (req) => {
    const { user, session } = owner(req); const b = (req.body ?? {}) as { clientId?: unknown; name?: unknown; instanceId?: unknown };
    return sync.register(user, session, b.clientId, b.name, b.instanceId);
  });
  app.post("/api/playback/sync", { bodyLimit: 2 * 1024 * 1024 }, (req) => {
    const { user, session } = owner(req); const b = req.body as Record<string, unknown>;
    if (!b || typeof b.deviceId !== "string") throw fail(400, "Invalid playback device");
    return sync.act(user, session, b.deviceId, b);
  });
  app.get("/api/playback/state", (req) => {
    const { user, session } = owner(req); const id = (req.query as { deviceId?: string }).deviceId;
    if (typeof id !== "string") throw fail(400, "Invalid playback device");
    return sync.read(user, session, id);
  });
  app.get("/api/playback/updates", async (req, reply) => {
    const { user, session } = owner(req); const id = (req.query as { deviceId?: string }).deviceId;
    if (typeof id !== "string") throw fail(400, "Invalid playback device");
    let dispose: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let opened = false;
    let ended = false;
    let blocked = false;
    let pending: SyncView | null = null;
    const flush = () => {
      if (ended || !opened || blocked || !pending || reply.raw.destroyed) return;
      const next = pending;
      pending = null;
      blocked = !reply.raw.write(`data: ${JSON.stringify(next)}\n\n`);
      if (blocked) reply.raw.once("drain", () => { blocked = false; flush(); });
    };
    const close = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      pending = null;
      dispose?.();
      streams.delete(close);
      if (opened && !reply.raw.destroyed) reply.raw.end();
    };
    const send = (view: SyncView) => { if (!ended) { pending = view; flush(); } };

    reply.raw.once("close", close);
    try { dispose = await sync.subscribe(user, session, id, send); }
    catch (error) { reply.raw.removeListener("close", close); throw error; }
    if (ended || reply.raw.destroyed) { dispose(); return; }

    reply.hijack();
    opened = true;
    streams.add(close);
    reply.raw.writeHead(200, { ...reply.getHeaders(), "content-type": "text/event-stream", "cache-control": "no-store",
      "x-accel-buffering": "no" } as import("node:http").OutgoingHttpHeaders);
    flush();
    let checking = false;
    timer = setInterval(() => {
      if (checking) return; checking = true;
      void accounts.authenticate(req.headers.cookie).then(async (auth) => {
        if (!auth || auth.user.id !== user || auth.session !== session) return close();
        send(await sync.read(user, session, id, false));
        if (!ended && !blocked && !reply.raw.write(": heartbeat\n\n")) {
          blocked = true;
          reply.raw.once("drain", () => { blocked = false; flush(); });
        }
      }).catch(close).finally(() => { checking = false; });
    }, 15000); timer.unref();
  });
  app.addHook("preClose", async () => { for (const close of [...streams]) close(); });
  app.addHook("onClose", async () => sync.close());
  return sync;
}
