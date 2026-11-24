import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { accountRequest } from "../stores/session";

type Status = { configured: boolean; connected: boolean; account: string;
  last: { title: string; artist: string; at: number } | null };

/** Optional sync of plays to the user's own YouTube Music history, which is what Recap is built from. */
export function YouTubeHistorySection() {
  const f = useT().features; const [status, setStatus] = useState<Status | null>(null);
  const [cookie, setCookie] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = () => void accountRequest<Status>("/api/youtube-history/status").then((data) => { if (!stopped) setStatus(data); }).catch(() => {});
    load(); const timer = setInterval(load, 10000); return () => { stopped = true; clearInterval(timer); };
  }, []);
  if (!status?.configured) return null;
  const connect = () => {
    setBusy(true); setError("");
    void accountRequest<{ account: string }>("/api/youtube-history/connect", { cookie })
      .then((data) => { setCookie(""); setStatus({ ...status, connected: true, account: data.account }); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  };
  return <section className="flex flex-col gap-3 border-t border-line pt-4">
    <h3 className="text-sm font-semibold">{f.ytHistory}</h3>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {status.connected ? <>
      <p className="text-sm text-fg-2">{status.account ? f.ytHistoryLinkedAs(status.account) : f.ytHistoryLinked}</p>
      {status.last && <p className="text-sm text-fg-2">{f.ytHistoryLast}: {status.last.title} · {status.last.artist}</p>}
      <button className="button-secondary" type="button" onClick={() => void accountRequest("/api/youtube-history/disconnect", {}).then(() => setStatus({ ...status, connected: false, account: "", last: null })).catch((e) => setError(e.message))}>{f.ytHistoryDisconnect}</button>
    </> : <>
      <p className="text-sm text-fg-2">{f.ytHistoryHelp}</p>
      <p className="text-xs text-fg-3">{f.ytHistoryWarning}</p>
      <textarea className="min-h-20 w-full rounded-2xl bg-surface-1 p-3 font-mono text-xs ring-1 ring-line-strong" value={cookie} onChange={(e) => setCookie(e.target.value)}
        placeholder={f.ytHistoryPlaceholder} autoComplete="off" spellCheck={false} aria-label={f.ytHistoryPlaceholder} />
      <button className="button-secondary" type="button" disabled={busy || !cookie.trim()} onClick={connect}>{busy ? f.ytHistoryChecking : f.ytHistoryConnect}</button>
    </>}
  </section>;
}
