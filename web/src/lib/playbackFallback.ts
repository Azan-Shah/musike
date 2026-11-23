import type { Track } from "./types";

/** One bounded pass; never substitute a remote track or silently loop the failed one. */
export async function nextDownloaded(queue: Track[], index: number, wrap: boolean,
  read: (id: string) => Promise<Blob | null>, valid: () => boolean) {
  const count = (wrap ? queue.length - 1 : queue.length - index - 1);
  for (let step = 1; step <= count && valid(); step++) {
    const at = (index + step) % queue.length;
    const blob = await read(queue[at]!.id).catch(() => null);
    if (!valid()) return null;
    if (blob?.size && /^audio\//i.test(blob.type)) return { index: at, blob };
  }
  return null;
}
