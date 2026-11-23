import { ShortcutsDialog } from "../components/Dialogs";
import { useShortcuts } from "../hooks/useShortcuts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { Rail } from "../components/Rail";
import { MiniPlayer, TabBar } from "../components/MobileChrome";
import { PlayerBar } from "../components/PlayerBar";
import { NowPlayingSheet, PanelDrawer, SidePanel } from "../components/NowPlaying";
import { SettingsDialog } from "../components/SettingsDialog";
import { Toasts } from "../components/Toasts";
import { MD, useMediaQuery } from "../hooks/useMediaQuery";
import { useRouteScroll } from "../hooks/useRouteScroll";
import { useT } from "../i18n";
import { cancelOfflineDownloads, logoutOfflineData, offlineOwner, refreshOffline, offlineLibrarySnapshot } from "../lib/offlineDownloads";
import { offlineSummary } from "../lib/offlineStore";
import { setOfflineOutput } from "../lib/playbackSync";
import { NOW_PLAYING_HASH, paths } from "../lib/routes";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";
import { useUi } from "../stores/ui";
import { accountRequest, useSession, type SessionInfo } from "../stores/session";
import { TrackListSkeleton } from "../components/TrackList";
const Library = lazy(() => import("./Library"));
const Collection = lazy(() => import("./Collection"));

export default function OfflineLibrary() {
  const [params] = useSearchParams();
  useEffect(() => { void refreshOffline(); }, []);
  return params.get("view") === "tracks" ? <Collection kind="history" downloaded /> : <Library downloads />;
}
export function OfflineExperience() {
  const t = useT(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [canPlay, setCanPlay] = useState(false);
  useShortcuts();
  const reconnectGeneration = useRef(0);
  useEffect(() => () => { reconnectGeneration.current++; }, []);
  const isMd = useMediaQuery(MD); const location = useLocation(); const navigate = useNavigate();
  const hasTrack = usePlayer(s => s.queue.length > 0);
  const panelOpen = useUi(s => s.panelOpen);
  const main = useRef<HTMLElement>(null); useRouteScroll(main);
  useEffect(() => {
    let stopped = false; const owner = offlineOwner();
    void refreshOffline();
    void offlineLibrarySnapshot().then(library => { if (!stopped && owner === offlineOwner()) useLibrary.setState({ ...library, status: "ready" }); }).catch(() => { if (!stopped) setError(t.offline.storageUnavailable); });
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    let stopped = false; let unlock: (() => void) | undefined;
    cancelOfflineDownloads(); setOfflineOutput(false); usePlayer.getState().suspendOutput();
    const owner = offlineOwner();
    if (owner) void offlineSummary(owner).then(async data => {
      if (stopped) return;
      if (!data.settings.eligible) { setError(t.offline.outputBlocked); return; }
      if (!navigator.locks) { setError(t.offline.tabBlocked); return; }
      await navigator.locks.request(`musike-offline-output:${owner}`, { ifAvailable: true }, async lock => {
        if (stopped) return;
        if (!lock) { setError(t.offline.tabBlocked); return; }
        setOfflineOutput(true); setCanPlay(true);
        await new Promise<void>(resolve => { unlock = resolve; });
      });
    }).catch(() => setError(t.offline.storageUnavailable));
    return () => { stopped = true; setOfflineOutput(false); usePlayer.getState().suspendOutput(); unlock?.(); };
  }, []);
  const reconnect = async () => {
    if (busy) return;
    const wasAllowed = canPlay; const stamp = ++reconnectGeneration.current; const owner = offlineOwner();
    setBusy(true); setOfflineOutput(false); usePlayer.getState().suspendOutput(); setCanPlay(false);
    try {
      const info = await accountRequest<SessionInfo>("/api/auth/me");
      if (stamp !== reconnectGeneration.current || owner !== offlineOwner()) return;
      // Reload after authentication: module-level queue keys and the online output grant must be fresh.
      if (!info.enabled || info.user?.id !== offlineOwner()) sessionStorage.removeItem("musike:user");
      window.location.reload();
    } catch {
      if (stamp !== reconnectGeneration.current || !useSession.getState().offline || owner !== offlineOwner()) return;
      setError(t.offline.onlineRequired); setBusy(false); setOfflineOutput(wasAllowed); setCanPlay(wasAllowed);
    }
  };
  useEffect(() => { const online = () => void reconnect(); addEventListener("online", online); return () => removeEventListener("online", online); }, [busy, canPlay]);
  return <div className="grain flex h-dvh flex-col bg-bg md:gap-2 md:p-2">
    <div className="flex min-h-0 flex-1 md:gap-2">
      <Rail />
      <main ref={main} className="scroll-area relative min-w-0 flex-1 overflow-y-auto pb-[calc(152px+env(safe-area-inset-bottom))] md:rounded-[20px] md:bg-surface-1 md:pb-0 md:ring-1 md:ring-line">
        <section className="flex flex-wrap items-center gap-3 px-4 pt-4 md:px-6"><p className="text-sm font-semibold text-fg-2">{t.offline.mode}</p>
          <button type="button" className="button-secondary" disabled={busy} onClick={() => void reconnect()}>{t.offline.reconnect}</button>
          <button type="button" className="button-secondary" onClick={() => { localStorage.setItem("musike:logout-pending", "1"); setOfflineOutput(false); usePlayer.getState().stopSession(); void logoutOfflineData().then(() => locationReload()).catch(() => setError(t.offline.storageUnavailable)); }}>{t.features.logout}</button>
          <button type="button" className="button-secondary md:hidden" onClick={() => useUi.getState().setSettingsOpen(true)}>{t.nav.settings}</button>
          {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
        </section>
        <Suspense fallback={<TrackListSkeleton />}><Routes>
          <Route path={paths.library} element={<Library downloads />} />
          <Route path={paths.offline} element={<OfflineLibrary />} />
          <Route path={paths.favorites} element={<Collection kind="favorites" />} />
          <Route path={paths.history} element={<Collection kind="history" />} />
          <Route path="/playlist/:id" element={<Collection kind="playlist" />} />
          <Route path="*" element={<Navigate to={paths.library} replace />} />
        </Routes>
        <span hidden data-route-ready /></Suspense>
      </main>
      {panelOpen && hasTrack && canPlay && <SidePanel />}
    </div>
    {canPlay && (isMd ? <PlayerBar /> : <><MiniPlayer /><TabBar /></>)}
    {canPlay && <><PanelDrawer /><NowPlayingSheet open={!isMd && location.hash === `#${NOW_PLAYING_HASH}`} onClose={() => navigate({ hash: "" }, { replace: true })} /></>}
    <ShortcutsDialog /><SettingsDialog /><Toasts />
  </div>;
}
const locationReload = () => window.location.reload();
