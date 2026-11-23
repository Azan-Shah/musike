import { recordPlayback, responseFailure } from "./playbackDiagnostics";

/** One complete next-track body; independent of the browser's advisory media preload budget. */
export class PlaybackPreload {
  private pending: { id: string; controller: AbortController } | null = null;
  private ready: { id: string; url: string; trace: string; blob: Blob } | null = null;
  private target: string | undefined;
  private attempts = 0;
  private retryAt = 0;
  private generation = 0;
  private hydrating: { id: string; generation: number } | null = null;
  constructor(private transport: typeof fetch = fetch, private limit = 16 * 1024 * 1024, private complete?: (id: string, blob: Blob) => void, private cached?: (id: string) => Promise<Blob | null>) {}
  retain(id?: string) {
    if (id !== this.target) { this.target = id; this.attempts = 0; this.retryAt = 0; this.generation++; }
    if (this.pending && this.pending.id !== id) { this.pending.controller.abort(); this.pending = null; }
    if (this.ready && this.ready.id !== id) { URL.revokeObjectURL(this.ready.url); this.ready = null; }
  }
  take(id: string) {
    if (this.ready?.id !== id) return null;
    const result = this.ready; this.ready = null; return result;
  }
  clear() { this.retain(); }
  async hydrate(id: string, trace: string) {
    if (!this.cached || this.target !== id || this.ready?.id === id || this.hydrating?.id === id && this.hydrating.generation === this.generation) return;
    const job = { id, generation: this.generation }; this.hydrating = job;
    try {
      const blob = await this.cached(id);
      if (this.generation !== job.generation || this.target !== id || !blob?.size || !/^audio\//.test(blob.type) || this.ready?.id === id) return;
      this.pending?.controller.abort(); this.pending = null;
      this.ready = { id, trace, url: URL.createObjectURL(blob), blob };
    } catch { /* Optional storage must not interrupt playback or cause an unhandled rejection. */ }
    finally { if (this.hydrating === job) this.hydrating = null; }
  }
  async prepare(id: string, source: string, trace: string) {
    if (this.ready?.id === id || this.pending?.id === id) return;
    this.retain(id);
    if (this.attempts >= 2) { if (Date.now() < this.retryAt) return; this.attempts = 0; }
    this.attempts++;
    const controller = new AbortController(); const job = { id, controller }; this.pending = job;
    let timedOut = false; let reason = "network"; let status: number | undefined;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
    try {
      const cached = await this.cached?.(id).catch(() => null);
      if (controller.signal.aborted || this.pending !== job) return;
      if (cached && cached.size && /^audio\//.test(cached.type)) {
        this.ready = { id, trace, url: URL.createObjectURL(cached), blob: cached }; return;
      }
      const response = await this.transport(source, { credentials: "same-origin", redirect: "manual", signal: controller.signal });
      if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("musike:unauthorized"));
      status = response.status;
      const failure = responseFailure(response);
      const length = Number(response.headers.get("content-length"));
      if (response.status !== 200 || failure || !response.body || !response.headers.get("content-type")?.startsWith("audio/") || length > this.limit) {
        reason = failure ?? (length > this.limit ? "size_limit" : response.status !== 200 ? "http_status" : "unexpected_content");
        await response.body?.cancel().catch(() => {}); throw new Error("response_or_limit");
      }
      const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > this.limit) { reason = "size_limit"; throw new Error("size_limit"); }
          chunks.push(new Uint8Array(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!bytes || length > 0 && bytes !== length) { reason = "incomplete_body"; throw new Error("incomplete"); }
      if (controller.signal.aborted || this.pending !== job) return;
      const blob = new Blob(chunks, { type: response.headers.get("content-type")! });
      this.ready = { id, trace, url: URL.createObjectURL(blob), blob };
      this.complete?.(id, blob);
      recordPlayback("player.preload_complete", { videoId: id, traceId: trace });
    } catch { recordPlayback("player.preload_incomplete", { videoId: id, traceId: trace, status, reason: controller.signal.aborted ? timedOut ? "timeout" : "cancelled" : reason }); }
    finally {
      clearTimeout(timeout);
      if (this.pending === job) { this.pending = null; this.retryAt = Date.now() + 30_000; }
    }
  }
}
