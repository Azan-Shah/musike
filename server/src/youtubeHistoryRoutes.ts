import type { FastifyInstance, FastifyRequest } from "fastify";
import { fail, type Accounts } from "./accounts.js";
import { YouTubeHistory, type HistoryClientFactory } from "./youtubeHistory.js";

export function registerYouTubeHistory(app: FastifyInstance, accounts: Accounts | null, factory?: HistoryClientFactory) {
  if (!accounts) return null;
  const log = app.log.child({ component: "youtube-history" }, { level: "info" });
  const history = new YouTubeHistory(accounts, factory, (event) => log.info(event));
  const user = (req: FastifyRequest) => { if (!req.musikeUser) throw fail(401, "Login required"); return req.musikeUser.id; };
  app.get("/api/youtube-history/status", (req) => history.status(user(req)));
  // The pasted cookie is the request body: keep it out of Fastify's request logging and limit its size.
  app.post("/api/youtube-history/connect", { bodyLimit: 20_000, logLevel: "warn" }, (req) => history.connect(user(req), (req.body as { cookie?: unknown } | null)?.cookie));
  app.post("/api/youtube-history/disconnect", async (req) => { await history.disconnect(user(req)); return { ok: true }; });
  app.addHook("onClose", () => history.close());
  return history;
}
