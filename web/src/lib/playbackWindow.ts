import { PlaybackPreload } from "./playbackPreload";

/** Nearest-first, one network reader, three bounded complete bodies. */
export class PlaybackWindow {
  private order: string[] = [];
  private entries = new Map<string, PlaybackPreload>();
  private queued = new Map<string, { source: string; trace: string }>();
  private running = false;
  constructor(private transport: typeof fetch, private limit: number,
    private complete: (id: string, blob: Blob) => void, private cached: (id: string) => Promise<Blob | null>) {}
  retain(ids: string | string[] = []) {
    this.order = [...new Set(typeof ids === "string" ? [ids] : ids)].slice(0, 3);
    for (const [id, entry] of this.entries) if (!this.order.includes(id)) { entry.clear(); this.entries.delete(id); this.queued.delete(id); }
    for (const id of this.order) if (!this.entries.has(id)) {
      const entry = new PlaybackPreload(this.transport, this.limit, this.complete, async key => {
        const blob = await this.cached(key); return blob && blob.size <= this.limit ? blob : null;
      });
      entry.retain(id); this.entries.set(id, entry);
    }
  }
  take(id: string) { return this.entries.get(id)?.take(id) ?? null; }
  clear() { this.retain(); }
  hydrate(id: string, trace: string) { return this.entries.get(id)?.hydrate(id, trace) ?? Promise.resolve(); }
  prepare(id: string, source: string, trace: string) {
    if (!this.entries.has(id)) return;
    this.queued.set(id, { source, trace }); void this.drain();
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const id = this.order.find(key => this.queued.has(key)); if (!id) return;
        const job = this.queued.get(id)!; this.queued.delete(id);
        await this.entries.get(id)?.prepare(id, job.source, job.trace);
      }
    } finally { this.running = false; }
  }
}
