import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useT } from "../i18n";
import { incomingShares } from "../lib/social";

const PAGE_SIZE = 30;
type SharePage = Awaited<ReturnType<typeof incomingShares>>;

export function IncomingShares() {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<SharePage>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void incomingShares(offset, PAGE_SIZE, controller.signal).then(
      result => { if (!controller.signal.aborted) setPage(result); },
      () => { if (!controller.signal.aborted) setError(true); },
    );
    return () => controller.abort();
  }, [offset, retry]);
  const active = page?.shareOffset === offset ? page : undefined;
  if (!offset && active && !active.shares.length && !active.hasMore) return null;
  return <section className="px-4 pt-4 md:px-6">
    <h2 className="font-semibold">{t.collaboration.sharedWithMe}</h2>
    {error ? <button type="button" className="button-secondary mt-2" onClick={() => { setError(false); setRetry(retry + 1); }}>{t.common.retry}</button>
      : active ? <ul className="flex flex-col gap-2 pt-3">{active.shares.map(s => <li key={s.id}>
        <Link className="text-sm text-accent-text" to={`/shared/${s.id}`}>{s.name} · {s.owner.name || t.collaboration.member} · {t.common.tracks(s.tracks)}</Link>
      </li>)}</ul> : <p role="status" className="pt-2 text-sm text-fg-2">{t.common.loading}</p>}
    {(offset > 0 || page?.hasMore) && <div className="flex flex-wrap gap-2 pt-3">
      <button type="button" className="button-secondary" disabled={!offset} onClick={() => { setError(false); setOffset(offset - PAGE_SIZE); }}>{t.trackList.previous}</button>
      <button type="button" className="button-secondary" disabled={!active?.hasMore || error} onClick={() => setOffset(offset + PAGE_SIZE)}>{t.trackList.next}</button>
    </div>}
  </section>;
}
