import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/Page";
import { JamPanel } from "../components/JamPanel";
import { useT } from "../i18n";
import { incomingShares, socialOverview, socialPresence, type SocialState } from "../lib/social";
import { accountRequest, useSession } from "../stores/session";
import { useLibrary } from "../stores/library";
const sharePageSize = 30;
const input = "h-11 w-full rounded-full bg-surface-1 px-4 text-sm ring-1 ring-line-strong";
export default function Social() {
  const t = useT(); const c = t.collaboration; const user = useSession(s => s.user); const playlists = useLibrary(s => s.playlists);
  const [shareOffset, setShareOffset] = useState(0);
  const owner = user?.id;
  const [overview, setOverview] = useState<{ owner: string; data: SocialState }>();
  const [shares, setShares] = useState<{ owner: string; page: Awaited<ReturnType<typeof incomingShares>> }>();
  const [revision, refresh] = useState(0);
  const [error, setError] = useState("");
  const [shareError, setShareError] = useState("");
  const rosterRequest = useRef<AbortController | null>(null);
  const shareRequest = useRef<AbortController | null>(null);
  const playlistNames = useMemo(() => new Map(playlists.map(p => [p.id, p.name])), [playlists]);
  const state = overview?.owner === owner ? overview?.data : undefined;
  const sharePage = shares?.owner === owner && shares?.page.shareOffset === shareOffset ? shares.page : undefined;
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("friend") ?? ""); const [name, setName] = useState("");
  const [group, setGroup] = useState<{ id: string; owner_id: string; name: string; members: { id: string; name: string }[] } | null>(null);
  const [member, setMember] = useState(""); const [playlist, setPlaylist] = useState(""); const [recipient, setRecipient] = useState(""); const [permission, setPermission] = useState("viewer");
  useEffect(() => {
    if (!owner) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastOverview = 0;
    let disposed = false;
    const stop = () => { clearTimeout(timer); rosterRequest.current?.abort(); };
    async function poll(force = false) {
      stop();
      if (document.hidden) return;
      const request = new AbortController();
      rosterRequest.current = request;
      const current = () => !disposed && !request.signal.aborted;
      try {
        if (force || Date.now() - lastOverview >= 30_000) {
          const data = await socialOverview(request.signal);
          if (current()) { lastOverview = Date.now(); setOverview({ owner: owner!, data }); }
        } else {
          const { friends } = await socialPresence(request.signal);
          if (current()) setOverview(old => old && old.owner === owner ? { ...old, data: { ...old.data, friends } } : old);
        }
      } catch (error) {
        if (current()) setError((error as Error).message);
      } finally {
        if (current()) timer = setTimeout(() => void poll(), 5000);
      }
    }
    const visible = () => void poll(true);
    void poll(true);
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; stop(); document.removeEventListener("visibilitychange", visible); };
  }, [owner, revision]);

  useEffect(() => {
    if (!owner) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { clearTimeout(timer); shareRequest.current?.abort(); };
    async function loadPage() {
      stop();
      if (document.hidden) return;
      const request = new AbortController();
      shareRequest.current = request;
      try {
        const page = await incomingShares(shareOffset, sharePageSize, request.signal);
        if (!request.signal.aborted) { setShares({ owner: owner!, page }); setShareError(""); }
      } catch (error) {
        if (!request.signal.aborted) setShareError((error as Error).message);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(() => void loadPage(), 30_000);
      }
    }
    const visible = () => void loadPage();
    void loadPage();
    document.addEventListener("visibilitychange", visible);
    return () => { stop(); document.removeEventListener("visibilitychange", visible); };
  }, [owner, shareOffset, revision]);

  const run = async (path: string, body?: unknown, method?: string) => {
    setError("");
    const current = () => useSession.getState().user?.id === owner;
    try {
      await accountRequest(path, body, method);
      if (!current()) return;
      rosterRequest.current?.abort();
      shareRequest.current?.abort();
      refresh(value => value + 1);
      if (group) {
        const update = await accountRequest<NonNullable<typeof group>>(`/api/social/groups/${group.id}`).catch(() => null);
        if (current()) setGroup(shown => shown?.id === group.id ? update : shown);
      }
    } catch (error) { if (current()) setError((error as Error).message); }
  };
  if (!user) return <><PageHeader title={c.social} /><p className="p-4 text-sm text-fg-2">{c.accountRequired}</p></>;
  if (!state) return <><PageHeader title={c.social} /><p className="p-4 text-sm text-fg-2" role="status">{error || t.common.loading}</p></>;
  const share = (revoke = false) => { const [kind, id] = recipient.split(":"); return run("/api/social/shares", { playlist, ...(kind === "group" ? { group: id } : { user: id }), permission, revoke }); };
  return <><PageHeader title={c.social} /><div className="flex flex-col gap-5 p-4 md:p-6">
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <JamPanel />
    <section className="flex flex-col gap-3 rounded-panel bg-surface-2 p-4"><h2 className="font-semibold">{c.friends}</h2>
      <label className="flex flex-col gap-2 text-sm">{c.yourFriendCode}<input className={input} readOnly value={state.code} onFocus={e => e.target.select()} /></label>
      <label className="flex flex-col gap-2 text-sm">{c.friendLink}<input className={input} readOnly value={`${location.origin}/social?friend=${encodeURIComponent(state.code)}`} onFocus={e => e.target.select()} /></label>
      <label className="flex flex-col gap-2 text-sm">{c.friendCode}<input className={input} value={code} onChange={e => setCode(e.target.value)} /></label>
      <button type="button" className="button-secondary" disabled={!code} onClick={() => void run("/api/social/friends", { code })}>{c.sendRequest}</button>
      <ul className="flex flex-col gap-2">{state.requests.map(r => <li key={`${r.sender}:${r.recipient}`} className="flex flex-wrap items-center gap-2 text-sm"><span>{r.name || c.member} · {r.recipient === user.id ? c.incoming : c.outgoing}</span>
        {r.recipient === user.id ? <><button type="button" className="button-secondary" onClick={() => void run(`/api/social/requests/${r.sender}`, { accept: true })}>{c.accept}</button><button type="button" className="button-secondary" onClick={() => void run(`/api/social/requests/${r.sender}`, { accept: false })}>{c.decline}</button></> : <button type="button" className="button-secondary" onClick={() => void run(`/api/social/friends/${r.recipient}`, undefined, "DELETE")}>{t.common.cancel}</button>}</li>)}</ul>
      <ul className="flex flex-col gap-2">{state.friends.map(f => <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{f.name || c.member} · {f.online === null ? c.privatePresence : f.online ? c.online : c.offline}{f.track ? ` · ${f.track.title} — ${f.track.artist}` : ""}</span><button type="button" className="button-secondary" onClick={() => void run(`/api/social/friends/${f.id}`, undefined, "DELETE")}>{c.remove}</button></li>)}</ul>
      <h3 className="text-sm font-medium">{c.privacy}</h3><p className="text-xs text-fg-2">{c.privacyHelp}</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={state.preferences.online} onChange={e => void run("/api/social/preferences", { ...state.preferences, online: e.target.checked }, "PATCH")} />{c.showOnline}</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={state.preferences.track} onChange={e => void run("/api/social/preferences", { ...state.preferences, track: e.target.checked }, "PATCH")} />{c.showTrack}</label>
    </section>
    <section className="flex flex-col gap-3 rounded-panel bg-surface-2 p-4"><h2 className="font-semibold">{c.groups}</h2>
      <label className="flex flex-col gap-2 text-sm">{t.features.name}<input className={input} maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label><button type="button" className="button-secondary" disabled={!name.trim()} onClick={() => void run("/api/social/groups", { name })}>{c.createGroup}</button>
      <ul className="flex flex-col gap-2">{state.groups.map(g => <li key={g.id}><button type="button" className="button-secondary" onClick={() => void accountRequest<NonNullable<typeof group>>(`/api/social/groups/${g.id}`).then(setGroup).catch(e => setError(e.message))}>{g.name}</button></li>)}</ul>
      {group && <div className="flex flex-col gap-2 border-t border-line pt-3"><h3 className="font-medium">{group.name}</h3>
        {group.owner_id === user.id && <><label className="flex flex-col gap-2 text-sm">{c.addFriend}<select className={input} value={member} onChange={e => setMember(e.target.value)}><option value="">{c.selectFriend}</option>{state.friends.filter(f => !group.members.some(m => m.id === f.id)).map(f => <option key={f.id} value={f.id}>{f.name || c.member}</option>)}</select></label><button type="button" className="button-secondary" disabled={!member} onClick={() => void run(`/api/social/groups/${group.id}`, { member }, "PATCH")}>{c.add}</button>
          <button type="button" className="button-secondary" disabled={!name.trim()} onClick={() => void run(`/api/social/groups/${group.id}`, { name }, "PATCH")}>{c.renameGroup}</button></>}
        <ul>{group.members.map(m => <li key={m.id} className="flex items-center justify-between gap-2 py-1 text-sm"><span>{m.name || c.member}</span>{m.id !== group.owner_id && (group.owner_id === user.id || m.id === user.id) && <button type="button" className="button-secondary" onClick={async () => { const id = group.id; if (m.id === user.id) setGroup(null); await run(`/api/social/groups/${id}`, { member: m.id, remove: true }, "PATCH"); }}>{m.id === user.id ? c.leave : c.remove}</button>}</li>)}</ul>
        {group.owner_id === user.id && <button type="button" className="button-secondary" onClick={() => { const id = group.id; setGroup(null); void run(`/api/social/groups/${id}`, { delete: true }, "PATCH"); }}>{c.deleteGroup}</button>}
      </div>}
    </section>
    <section className="flex flex-col gap-3 rounded-panel bg-surface-2 p-4"><h2 className="font-semibold">{c.sharePlaylist}</h2>
      <label className="flex flex-col gap-2 text-sm">{t.common.playlist}<select className={input} value={playlist} onChange={e => setPlaylist(e.target.value)}><option value="">{c.selectPlaylist}</option>{playlists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="flex flex-col gap-2 text-sm">{c.recipient}<select className={input} value={recipient} onChange={e => setRecipient(e.target.value)}><option value="">{c.selectRecipient}</option>{state.friends.map(f => <option key={f.id} value={`friend:${f.id}`}>{f.name || c.member}</option>)}{state.groups.filter(g => g.owner_id === user.id).map(g => <option key={g.id} value={`group:${g.id}`}>{c.group}: {g.name}</option>)}</select></label>
      <label className="flex flex-col gap-2 text-sm">{c.permission}<select className={input} value={permission} onChange={e => setPermission(e.target.value)}><option value="viewer">{c.viewer}</option><option value="editor">{c.editor}</option></select></label>
      <div className="flex flex-wrap gap-2"><button type="button" className="button-secondary" disabled={!playlist || !recipient} onClick={() => void share()}>{c.share}</button><button type="button" className="button-secondary" disabled={!playlist || !recipient} onClick={() => void share(true)}>{c.revoke}</button></div>
      <p className="text-xs text-fg-2">{c.copyHelp}</p>
      <h3 className="text-sm font-medium">{c.myShares}</h3><ul>{state.owned.map(s => <li key={s.id} className="flex items-center justify-between gap-2 py-1 text-sm"><Link to={`/shared/${s.id}`} className="text-accent-text">{playlistNames.get(s.playlist_id) || c.removedPlaylist}</Link><button type="button" className="button-secondary" onClick={() => void run(`/api/shared-playlists/${s.id}`, undefined, "DELETE")}>{c.stopSharing}</button></li>)}</ul>
      <h3 className="text-sm font-medium">{c.sharedWithMe}</h3>
      {shareError && <p role="status" className="text-sm text-danger">{shareError}</p>}
      <div className="flex gap-2">
        <button type="button" className="button-secondary" disabled={!shareOffset}
          onClick={() => setShareOffset(Math.max(0, shareOffset - sharePageSize))}>{c.previous}</button>
        <button type="button" className="button-secondary" disabled={!sharePage?.hasMore}
          onClick={() => setShareOffset(shareOffset + sharePageSize)}>{c.next}</button>
      </div>
      <ul>{sharePage?.shares.map(s => <li key={s.id} className="py-1 text-sm">
        <Link className="text-accent-text" to={`/shared/${s.id}`}>{s.name} · {s.owner.name || c.member} · {s.permission === "editor" ? c.editor : c.viewer}</Link>
      </li>)}</ul>
    </section>
  </div></>;
}
