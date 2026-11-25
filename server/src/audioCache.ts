import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { playbackStage } from "./playbackDiagnostics.js";
import { HttpError } from "./types.js";
import { msg } from "./i18n.js";
import { config } from "./config.js";
import { resolveDirectAudio, invalidate, resolveStreams, type StreamFormat } from "./ytdlp.js";
import { TaskQueue, QueueError } from "./taskQueue.js";
import { needWindow, releaseWindow, reserveBytes, releaseBytes, consumeBytes, leaseFile, mutateCache, acquireFileLease } from "./cacheBudget.js";

import { measureLoudness, validLoudness, type LoudnessMeasurement } from "./mediaLoudness.js";
import { tools } from "./tools.js";

type CachedAudio = { file: string; mime: string; loudness?: LoudnessMeasurement };
type CacheMetadata = { mime: string; size: number; analysis?: LoudnessMeasurement & { rendition: string } };
const renditionOf = (info: Awaited<ReturnType<typeof stat>>) => `${info.dev}:${info.ino}:${info.birthtimeMs}:${info.size}`;
export class BudgetFull extends Error {}
const aborted = () => new DOMException("Aborted", "AbortError");
const check = (signal: AbortSignal) => { if (signal.aborted) throw aborted(); };
export function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(aborted()); }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Primary and direct fallback are resolved ahead of playback; only a successful complete body is published. */
export type CandidateProvider = (id: string, signal: AbortSignal) => Promise<Iterable<StreamFormat>> | AsyncIterable<StreamFormat>;
export async function* readyCandidates(jobs: Promise<StreamFormat>[], signal: AbortSignal): AsyncGenerator<StreamFormat> {
  const pending = new Map(jobs.map((job, i) => [i, job.then((value) => ({ i, value }), () => ({ i, value: null }))]));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  while (pending.size) {
    const next = await cancellable(Promise.race(pending.values()), deadline); pending.delete(next.i);
    if (next.value) yield next.value;
  }
}
export async function* audioCandidates(id: string, signal: AbortSignal): AsyncGenerator<StreamFormat> {
  const resolve = async (source: "primary" | "direct", work: () => Promise<StreamFormat>) => {
    const started = Date.now(); playbackStage("source.resolve", { videoId: id, source });
    try { const format = await work(); playbackStage("source.resolved", { videoId: id, source, ms: Date.now() - started }); return format; }
    catch (error) {
      const status = error instanceof HttpError ? error.status : undefined;
      const reason = signal.aborted ? "cancelled" : error instanceof HttpError && error.code ? error.code :
        status === 404 ? "unavailable" : status === 403 ? "restricted" : status === 504 ? "timeout" : "provider";
      playbackStage(signal.aborted ? "source.resolve_failed" : "source.resolve_error", { videoId: id, source, ms: Date.now() - started, status, reason });
      throw error;
    }
  };
  yield* readyCandidates([
    resolve("primary", () => resolveStreams(id, signal).then((result) => result.audio)),
    resolve("direct", () => resolveDirectAudio(id, signal).then((result): StreamFormat => ({ formatId: "fallback", url: result.url, mime: result.mime, headers: {} }))),
  ], signal);
}

/** Race usable first bytes, not just resolved URLs. Never wait for a whole file before cold playback. */
const sourceSelections = new TaskQueue(8, 24, 5000);
export async function openAudioSource(id: string, signal: AbortSignal, candidates: CandidateProvider = audioCandidates,
  transport: typeof fetch = fetch, range?: string, timeoutMs = 20_000) {
  const queued = Date.now(); playbackStage("source.queued", { videoId: id });
  try { return await sourceSelections.run(() => {
    const waiting = Date.now() - queued; playbackStage("source.started", { videoId: id, ms: waiting });
    return raceAudioSource(id, signal, candidates, transport, range, Math.max(1, timeoutMs - waiting));
  }, signal); }
  catch (error) { if (error instanceof QueueError) throw new HttpError(503, msg("serverBusy"), "server_busy"); throw error; }
}
async function raceAudioSource(id: string, signal: AbortSignal, candidates: CandidateProvider = audioCandidates,
  transport: typeof fetch = fetch, range?: string, timeoutMs = 20_000) {
  check(signal); const started = Date.now(); const discovery = new AbortController();
  const controllers = new Set<AbortController>();
  return new Promise<{ format: StreamFormat; response: Response; cancel: () => void }>((resolve, reject) => {
    let settled = false; let enumerated = false; let active = 0;
    let rejectedUrl = false; let refreshed = false;
    const finishError = (error: Error) => {
      if (settled) return; settled = true; clearTimeout(deadline); discovery.abort();
      for (const controller of controllers) controller.abort();
      signal.removeEventListener("abort", cancelled); reject(error);
    };
    const cancelled = () => finishError(aborted());
    const deadline = setTimeout(() => finishError(new HttpError(504, msg("playbackTimeout"))), timeoutMs);
    signal.addEventListener("abort", cancelled, { once: true });
    const failed = () => {
      if (!enumerated || active || settled) return;
      if (rejectedUrl && !refreshed && !signal.aborted) {
        refreshed = true; enumerated = false; invalidate(id);
        playbackStage("source.refresh", { videoId: id, reason: "url_rejected" });
        void discover(); return;
      }
      playbackStage("source.error", { videoId: id, status: 502, reason: "all_candidates_failed", ms: Date.now() - started });
      finishError(new HttpError(502, msg("noAudio")));
    };
    const attempt = async (format: StreamFormat) => {
      if (settled || !["audio/mp4", "audio/webm"].includes(format.mime)) return;
      active++; const controller = new AbortController(); controllers.add(controller);
      let timedOut = false; let reason = "network";
      const source = format.formatId === "fallback" || format.formatId === "direct" ? "direct" : "primary";
      const firstByteTimer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(8000, timeoutMs));
      try {
        playbackStage("source.open", { videoId: id, source: format.formatId === "fallback" || format.formatId === "direct" ? "direct" : "primary" });
        const response = await transport(format.url, { headers: { ...format.headers, ...(range ? { Range: range } : {}) },
          signal: AbortSignal.any([signal, controller.signal]) });
        const badType = /text\/html|application\/json/i.test(response.headers.get("content-type") ?? "");
        if ((!response.ok && response.status !== 416) || badType || !response.body && response.status !== 416) {
          reason = !response.ok ? "http_status" : badType ? "unexpected_content" : "missing_body";
          if (response.status === 403 || response.status === 410) rejectedUrl = true;
          playbackStage("source.candidate_error", { videoId: id, source, reason, status: response.status });
          await response.body?.cancel(); invalidate(id); throw new Error("refused");
        }
        if (response.status === 416) await response.body?.cancel();
        const reader = response.status === 416 ? undefined : response.body?.getReader();
        const first = response.status === 416 ? null : await reader!.read();
        if (first?.done || first && !first.value.byteLength) { reason = "empty_body"; await reader?.cancel(); throw new Error("empty"); }
        clearTimeout(firstByteTimer);
        if (settled) { await reader?.cancel(); controller.abort(); return; }
        settled = true; clearTimeout(deadline); signal.removeEventListener("abort", cancelled); discovery.abort();
        for (const other of controllers) if (other !== controller) other.abort();
        playbackStage("source.first_byte", { videoId: id, ms: Date.now() - started, status: response.status,
          source: format.formatId === "fallback" || format.formatId === "direct" ? "direct" : "primary" });
        let initial = first?.value;
        const body = response.status === 416 ? null : new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              if (initial) { stream.enqueue(initial); initial = undefined; return; }
              const next = await cancellable(reader!.read(), AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
              if (next.done) stream.close(); else stream.enqueue(next.value);
            } catch (error) { controller.abort(); await reader?.cancel().catch(() => {}); stream.error(error); }
          },
          async cancel() { controller.abort(); await reader?.cancel().catch(() => {}); },
        });
        resolve({ format, response: new Response(body, { status: response.status, headers: response.headers }), cancel: () => controller.abort() });
      } catch (error) {
        clearTimeout(firstByteTimer); controller.abort();
        const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (error as { code?: unknown })?.code;
        const network = code === "ENOTFOUND" || code === "EAI_AGAIN" ? "dns" : code === "ECONNRESET" ? "connection_reset" : code === "ETIMEDOUT" ? "timeout" : reason;
        playbackStage("source.candidate_error", { videoId: id, source, ms: Date.now() - started, reason: signal.aborted ? "cancelled" : timedOut ? "first_byte_timeout" : network });
      } finally { active--; controllers.delete(controller); failed(); }
    };
    async function discover() {
      try { for await (const format of await candidates(id, AbortSignal.any([signal, discovery.signal]))) {
        if (settled) break; void attempt(format);
      } } catch { if (!settled && !signal.aborted) playbackStage("source.discovery_error", { videoId: id, reason: "provider" }); }
      finally { enumerated = true; failed(); }
    }
    void discover();
  });
}

export interface AudioSourceOptions { candidates?: CandidateProvider; transport?: typeof fetch; timeoutMs?: number; }

export class AudioCache {
  private jobs = new TaskQueue(2, 16, 30_000);
  private analyses = new TaskQueue(1, 8, 15_000);
  private analyzing = new Map<string, Promise<void>>();
  private rejectedAnalyses = new Map<string, number>();
  private analysisStop = new AbortController();
  private windows = new Map<string, { controller: AbortController; signature: string; blocked: boolean; budget: number; revision: number; retryAt: number }>();
  private inflight = new Map<string, { controller: AbortController; consumers: Set<symbol>; work: Promise<CachedAudio> }>();
  constructor(private candidates: CandidateProvider = audioCandidates, private transport: typeof fetch = fetch,
    private debug: (message: string) => void = () => {}) {}
  async find(id: string): Promise<CachedAudio | null> {
    const file = path.join(config.cacheDir, `${id}.audio.bin`);
    try {
      const meta = JSON.parse(await readFile(file.replace(/\.bin$/, ".json"), "utf8")) as CacheMetadata;
      const info = await stat(file);
      if (info.size !== meta.size || !["audio/mp4", "audio/webm"].includes(meta.mime)) return null;
      if (Date.now() - info.mtimeMs >= 30_000) {
        const now = new Date();
        await utimes(file, now, now).catch(() => {});
      }
      const rendition = renditionOf(info);
      const loudness = meta.analysis?.rendition === rendition && validLoudness(meta.analysis) ? meta.analysis : undefined;
      if (!loudness && info.size <= 64 * 1024 * 1024) this.analyze(file, rendition);
      return { file, mime: meta.mime, loudness };
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return null; throw e; }
  }
  private analyze(file: string, rendition: string) {
    const key = `${file}:${rendition}`;
    const signal = this.analysisStop.signal;
    if (signal.aborted || !tools().ffmpeg || this.analyzing.has(key) || this.analyzing.size >= 9 ||
      (this.rejectedAnalyses.get(key) ?? 0) > Date.now()) return;

    const metaFile = file.replace(/\.bin$/, ".json");
    const work = this.analyses.run(async () => {
      const release = await acquireFileLease(file);
      const temporary = `${metaFile}.${randomUUID()}.tmp`;
      try {
        if (renditionOf(await stat(file)) !== rendition) return;
        const analysis = await measureLoudness(file, signal);
        if (!analysis) throw new Error("No integrated loudness result");
        await mutateCache(async () => {
          if (signal.aborted || renditionOf(await stat(file)) !== rendition) return;
          const meta = JSON.parse(await readFile(metaFile, "utf8")) as CacheMetadata;
          await writeFile(temporary, JSON.stringify({ ...meta, analysis: { ...analysis, rendition } }), { flag: "wx" });
          await rename(temporary, metaFile);
        });
      } finally {
        release();
        await rm(temporary, { force: true });
      }
    }, signal).catch(() => {
      if (this.rejectedAnalyses.size >= 128) this.rejectedAnalyses.delete(this.rejectedAnalyses.keys().next().value!);
      this.rejectedAnalyses.set(key, Date.now() + 10 * 60_000);
    }).finally(() => this.analyzing.delete(key));
    this.analyzing.set(key, work);
  }

  async ensure(id: string, signal: AbortSignal): Promise<CachedAudio> {
    check(signal);
    const hit = await this.find(id); check(signal); if (hit) { playbackStage("prepare.hit", { videoId: id, warm: true }); return hit; }
    let job = this.inflight.get(id);
    if (job?.controller.signal.aborted) {
      await job.work.catch(() => {}); check(signal); return this.ensure(id, signal);
    }
    if (!job) {
      const controller = new AbortController();
      playbackStage("prepare.queued", { videoId: id });
      const work = this.jobs.run(async () => { check(controller.signal); return this.download(id, controller.signal); }, controller.signal)
        .finally(() => { if (this.inflight.get(id)?.controller === controller) this.inflight.delete(id); });
      job = { controller, work, consumers: new Set() }; this.inflight.set(id, job);
    }
    const consumer = Symbol(); job.consumers.add(consumer);
    try { return await cancellable(job.work, signal); }
    finally { job.consumers.delete(consumer); if (!job.consumers.size) job.controller.abort(); }
  }
  private async download(id: string, signal: AbortSignal): Promise<CachedAudio> {
    playbackStage("prepare.start", { videoId: id });
    const selected = await openAudioSource(id, signal, this.candidates, this.transport);
    const { format, response } = selected;
    const token = `${id}.${randomUUID()}`;
    const file = path.join(config.cacheDir, `${id}.audio.bin`);
    const tmp = path.join(config.cacheDir, `${token}.part`);
    const meta = `${file.replace(/\.bin$/, ".json")}.${token}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      if (response.status !== 200 || response.headers.has("content-range") || !response.body) throw new Error("No complete audio body");
      const length = Number(response.headers.get("content-length"));
      if (length > 0 && !await reserveBytes(token, length + 64, id)) throw new BudgetFull();
      await mkdir(config.cacheDir, { recursive: true }); handle = await open(tmp, "wx");
      const reader = response.body.getReader(); let size = 0;
      try {
        while (true) {
          check(signal); const { done, value } = await cancellable(reader.read(), AbortSignal.any([signal, AbortSignal.timeout(120_000)])); if (done) break;
          if ((!(length > 0) || size + value.byteLength > length) && !await reserveBytes(token, value.byteLength + (size ? 0 : 64), id)) throw new BudgetFull();
          await handle.writeFile(value); size += value.byteLength; await consumeBytes(token, value.byteLength);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      if (!size || length > 0 && size !== length) throw new Error("Incomplete audio cache body");
      await handle.close(); handle = null;
      const release = leaseFile(file);
      try { await mutateCache(async () => {
        await rename(tmp, file);
        await writeFile(meta, JSON.stringify({ mime: format.mime, size }));
        await rename(meta, file.replace(/\.bin$/, ".json"));
      }); } finally { release(); }
      playbackStage("prepare.complete", { videoId: id, bytes: size, warm: true });
      if (tools().ffmpeg && size <= 64 * 1024 * 1024) {
        void stat(file).then(info => this.analyze(file, renditionOf(info))).catch(() => {});
      }
      return { file, mime: format.mime };
    } finally {
      selected.cancel(); await response.body?.cancel().catch(() => {}); await handle?.close().catch(() => {});
      await rm(tmp, { force: true }); await rm(meta, { force: true }); await releaseBytes(token);
    }
  }
  update(client: string, current: string, upcoming: string[], depth: number, revision?: number) {
    const previous = this.windows.get(client);
    if (revision !== undefined && previous && revision <= previous.revision) return;
    const ids = [...new Set(upcoming)].filter((id) => id !== current).slice(0, depth);
    needWindow(client, [current, ...ids]);
    const signature = [current, ...ids].join("|");
    if (previous?.signature === signature && (!previous.blocked || previous.budget === config.cacheMaxBytes) && Date.now() < previous.retryAt) { previous.revision = revision ?? previous.revision + 1; return; }
    previous?.controller.abort();
    if (!this.windows.has(client) && this.windows.size >= 64) {
      const oldest = this.windows.keys().next().value!; this.windows.get(oldest)?.controller.abort(); this.windows.delete(oldest); releaseWindow(oldest);
    }
    const entry = { controller: new AbortController(), signature, blocked: false, budget: config.cacheMaxBytes, retryAt: Infinity, revision: revision ?? (previous?.revision ?? 0) + 1 };
    this.windows.set(client, entry);
    void (async () => {
      for (const id of ids) {
        try { await this.ensure(id, entry.controller.signal); }
        catch (e) {
          if (entry.controller.signal.aborted) break;
          entry.retryAt = Date.now() + 30_000;
          if (e instanceof BudgetFull) { entry.blocked = true; playbackStage("prepare.blocked", { videoId: id, reason: "budget" }); this.debug("Look-ahead stopped at cache budget"); break; }
          this.debug("Look-ahead item could not be cached");
        }
      }
    })();
  }
  async close() { for (const [client, entry] of this.windows) { entry.controller.abort(); releaseWindow(client); }
    this.windows.clear(); this.jobs.close(); for (const entry of this.inflight.values()) entry.controller.abort();
    this.analysisStop.abort(); this.analyses.close();
    await Promise.allSettled([...Array.from(this.inflight.values(), entry => entry.work), ...this.analyzing.values()]);
  }
}
