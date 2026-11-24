import { Innertube, Constants } from "youtubei.js";
import type { Accounts } from "./accounts.js";
import { fail } from "./accounts.js";
import { config } from "./config.js";
import type { PlaybackSnapshot } from "./playbackSync.js";
import { VIDEO_ID } from "./types.js";

/**
 * Optional, per-user sync of Musike plays to the user's own YouTube Music history (and so Recap).
 * Uses the same unofficial playback/watch-time pings as the YouTube Music web player, signed in with
 * cookies the user pasted. Cookies are stored encrypted and never logged. A failed ping never affects playback.
 */
export interface WatchPing { st: number; et: number; length: number; state: "playing" | "paused"; final: boolean; rt: number }
export interface PlayHandle { history(): Promise<void>; watchtime(ping: WatchPing): Promise<void> }
export interface HistoryClient { account(): Promise<string>; start(id: string): Promise<PlayHandle> }
export type HistoryClientFactory = (cookie: string) => Promise<HistoryClient>;
/** The last song this server added to the user's YouTube history. */
export type HistoryEvent = { title: string; artist: string; at: number };

/** Plays count once this much has really been heard, so skipped songs stay out of history. */
export const HISTORY_AFTER_SECONDS = 10;
/** Interval between watch-time reports while playing, close to the web player's cadence. */
export const WATCHTIME_EVERY_MS = 40_000;
/** A jump this far from the expected position is a seek, not normal progress. */
const SEEK_TOLERANCE = 3;
/** Position back near the start after real progress on the same track is a loop or replay. */
const RESTART_BEFORE = 3; const RESTART_AFTER = 10;
const STALE_MS = 60_000;

const WEB_MUSIC = { client_name: Constants.CLIENTS.YTMUSIC.NAME, client_version: Constants.CLIENTS.YTMUSIC.VERSION };

export const youtubeClient: HistoryClientFactory = async (cookie) => {
  const yt = await Innertube.create({ cookie, retrieve_player: false, lang: config.lang, location: config.location, fetch: config.fetch });
  return {
    async account() {
      const info = await yt.account.getInfo() as unknown as { contents?: { contents?: { account_name?: { toString(): string } }[] } };
      return info?.contents?.contents?.[0]?.account_name?.toString() ?? "";
    },
    async start(id) {
      const info = await yt.music.getInfo(id);
      const tracking = info.page[0]?.playback_tracking; const cpn = info.cpn;
      if (!tracking?.videostats_watchtime_url || !cpn) throw new Error("Playback tracking not available");
      const check = (response: Response) => { if (!response.ok) throw new Error(`YouTube stats ${response.status}`); };
      return {
        history: async () => check(await info.addToWatchHistory()),
        watchtime: async (p) => {
          const url = tracking.videostats_watchtime_url.replace("https://s.", "https://music.");
          const params: Record<string, string> = { cpn, st: p.st.toFixed(3), et: p.et.toFixed(3), cmt: p.et.toFixed(3), len: p.length.toFixed(3),
            state: p.state, rt: p.rt.toFixed(3), rtn: p.rt.toFixed(3), fmt: "251", volume: "100", muted: "0" };
          if (p.final) params.final = "1";
          check(await yt.actions.stats(url, WEB_MUSIC, params));
        },
      };
    },
  };
};

type Play = {
  id: string; title: string; artist: string; length: number; handle: Promise<PlayHandle | null>; chain: Promise<void>;
  startedAt: number; listened: number; segStart: number | null; lastPos: number; lastAt: number; lastPing: number; historySent: boolean;
};
type Link = { client: Promise<HistoryClient>; checkedAt: number } | null;

export class YouTubeHistory {
  readonly configured: boolean;
  private links = new Map<string, Link>(); private loading = new Map<string, Promise<Link>>();
  private plays = new Map<string, Play>(); private retryAt = new Map<string, number>(); private pending = new Set<Promise<void>>(); private events = new Map<string, HistoryEvent>();
  private timer: ReturnType<typeof setInterval>; private closed = false;
  constructor(readonly accounts: Accounts, private factory: HistoryClientFactory = youtubeClient, private log: (event: Record<string, unknown>) => void = () => {},
    private now = Date.now, enabled = process.env.MUSIKE_YOUTUBE_HISTORY !== "off") {
    this.configured = enabled;
    this.timer = setInterval(() => { for (const [user, play] of this.plays) if (this.now() - play.lastAt > STALE_MS) this.finish(user, play, play.lastPos); }, 15_000);
    this.timer.unref();
  }

  async status(user: string) {
    const row = this.configured ? await this.accounts.db.get("SELECT account FROM youtube_history_connections WHERE user_id=?", [user]) : null;
    return { configured: this.configured, connected: !!row, account: (row?.account as string | undefined) ?? "", last: this.events.get(user) ?? null };
  }

  async connect(user: string, cookie: unknown) {
    if (!this.configured) throw fail(503, "YouTube history sync is turned off on this server");
    if (typeof cookie !== "string") throw fail(400, "Paste your YouTube cookies");
    const value = cookie.trim().replace(/^cookie:\s*/i, "");
    if (!value || value.length > 16384 || /[\r\n]/.test(value) || !/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=/.test(value)) throw fail(400, "These don't look like signed-in YouTube cookies");
    let account = "";
    try { const client = await this.factory(value); account = (await client.account()).slice(0, 120); }
    catch { throw fail(400, "YouTube didn't accept these cookies. Copy them again from a signed-in browser"); }
    await this.accounts.db.run("INSERT INTO youtube_history_connections(user_id,encrypted,account,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted=excluded.encrypted,account=excluded.account,updated_at=excluded.updated_at",
      [user, this.accounts.box.seal(value, `youtube-history:${user}`), account, this.now()]);
    this.links.delete(user); this.retryAt.delete(user); this.log({ event: "youtube_history.connected", user });
    return { connected: true, account };
  }

  async disconnect(user: string) {
    const play = this.plays.get(user); if (play) this.finish(user, play, play.lastPos);
    this.links.delete(user); this.retryAt.delete(user); this.events.delete(user);
    await this.accounts.db.run("DELETE FROM youtube_history_connections WHERE user_id=?", [user]);
  }

  /** Drops cached cookies and the current play without deleting the stored link (account suspended or revoked). */
  forget(user: string) {
    const play = this.plays.get(user); if (play) this.finish(user, play, play.lastPos);
    this.links.delete(user); this.retryAt.delete(user);
  }

  private link(user: string): Promise<Link> {
    let pending = this.loading.get(user);
    if (!pending) {
      pending = this.accounts.db.get("SELECT d.encrypted FROM youtube_history_connections d JOIN users u ON u.id=d.user_id WHERE d.user_id=? AND u.status='approved'", [user])
        .then((row) => {
          const link: Link = row ? { client: this.factory(this.accounts.box.open(row.encrypted as string, `youtube-history:${user}`)), checkedAt: this.now() } : null;
          // Expired or rejected cookies: stop trying for a while instead of rebuilding a client on every snapshot.
          link?.client.catch(() => { this.log({ event: "youtube_history.client_failed", user }); if (this.links.get(user) === link) { this.links.set(user, null); this.retryAt.set(user, this.now() + 300_000); } });
          this.links.set(user, link); return link;
        })
        .catch(() => null).finally(() => this.loading.delete(user));
      this.loading.set(user, pending);
    }
    return pending;
  }

  /** Called with every confirmed playback snapshot from the active device. */
  observe(user: string, snapshot: PlaybackSnapshot) {
    if (!this.configured || this.closed) return;
    let cached = this.links.get(user);
    if (cached === null && (this.retryAt.get(user) ?? Infinity) <= this.now()) { this.retryAt.delete(user); this.links.delete(user); cached = undefined; }
    if (cached === null) return;
    if (cached === undefined) { void this.link(user).then((link) => { if (link) this.observe(user, snapshot); }); return; }
    this.track(user, snapshot, cached);
  }

  private track(user: string, snapshot: PlaybackSnapshot, link: NonNullable<Link>) {
    const now = this.now(); const track = snapshot.queue[snapshot.index]; const pos = snapshot.position;
    const playing = snapshot.status === "playing";
    let play = this.plays.get(user);
    if (play && (!track || track.id !== play.id)) { this.finish(user, play, this.expected(play, now)); play = undefined; }
    if (play && pos < RESTART_BEFORE && play.lastPos >= RESTART_AFTER) {
      // Same song back at the start: repeat-one, a one-song repeat-all queue or a manual replay. YouTube counts each as a new play.
      this.finish(user, play, Math.min(play.length || Infinity, this.expected(play, now)));
      play = undefined;
    }
    if (!track || !VIDEO_ID.test(track.id)) return;
    if (!play) {
      if (!playing) return;
      const length = [snapshot.duration, track.duration].find((v) => Number.isFinite(v) && v > 0) ?? 0;
      const handle = link.client.then((client) => client.start(track.id)).catch(() => { this.log({ event: "youtube_history.start_failed", user }); return null; });
      play = { id: track.id, title: track.title, artist: track.artist, length, handle, chain: Promise.resolve(), startedAt: now, listened: 0,
        segStart: pos, lastPos: pos, lastAt: now, lastPing: now, historySent: false };
      this.plays.set(user, play);
      return;
    }
    if (play.segStart !== null) {
      const expected = this.expected(play, now);
      if (Math.abs(pos - expected) > SEEK_TOLERANCE) {
        // Seek: report what was really heard, then continue from the new position.
        this.ping(user, play, play.segStart, Math.max(play.segStart, Math.min(expected, play.length || expected)), "playing", false);
        play.segStart = playing ? pos : null;
      } else play.listened += Math.max(0, pos - play.lastPos);
    }
    if (!playing && play.segStart !== null) {
      this.ping(user, play, play.segStart, pos, "paused", false); play.segStart = null;
    } else if (playing && play.segStart === null) {
      play.segStart = pos; play.lastPing = now;
    }
    play.lastPos = pos; play.lastAt = now;
    if (playing && !play.historySent && play.listened >= HISTORY_AFTER_SECONDS) {
      play.historySent = true;
      this.send(user, play, async (h) => { await h.history(); this.events.set(user, { title: play.title, artist: play.artist, at: this.now() }); }, "history");
    }
    if (playing && play.segStart !== null && now - play.lastPing >= WATCHTIME_EVERY_MS) { this.ping(user, play, play.segStart, pos, "playing", false); play.segStart = pos; }
  }

  private expected(play: Play, now: number) { return play.segStart === null ? play.lastPos : play.lastPos + (now - play.lastAt) / 1000; }

  private ping(user: string, play: Play, st: number, et: number, state: WatchPing["state"], final: boolean) {
    play.lastPing = this.now();
    // Listening before the play reached history (a quick skip) is not reported.
    if (!play.historySent) return;
    const ping: WatchPing = { st, et: Math.max(st, et), length: play.length, state, final, rt: (this.now() - play.startedAt) / 1000 };
    this.send(user, play, (h) => h.watchtime(ping), final ? "final" : state);
  }

  private send(user: string, play: Play, action: (handle: PlayHandle) => Promise<void>, kind: string) {
    const next = play.chain.then(async () => {
      const handle = await play.handle; if (!handle) return;
      try { await action(handle); this.log({ event: "youtube_history.ping", user, kind, outcome: "ok" }); }
      catch { this.log({ event: "youtube_history.ping", user, kind, outcome: "failed" }); }
    });
    play.chain = next; this.pending.add(next); void next.finally(() => this.pending.delete(next));
  }

  private finish(user: string, play: Play, pos: number) {
    if (play.segStart !== null) this.ping(user, play, play.segStart, pos, "paused", true);
    else if (play.historySent) this.ping(user, play, play.lastPos, play.lastPos, "paused", true);
    if (this.plays.get(user) === play) this.plays.delete(user);
  }

  /** Waits for pings already queued (tests and shutdown). */
  async flush() { while (this.pending.size) await Promise.all([...this.pending]); }

  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const [user, play] of this.plays) this.finish(user, play, play.lastPos);
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 3000).unref())]);
  }
}
