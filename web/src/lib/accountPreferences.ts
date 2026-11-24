import { accountRequest, useSession, type SessionInfo } from "../stores/session";
import { useUi, toast } from "../stores/ui";
import { useAppearance, currentAppearance, type Appearance } from "../stores/appearance";
import { getT, useI18n } from "../i18n";

/** Subscriptions run after AuthGate. Applying server state never produces a write-back loop. */
export function startAccountPreferences() {
  let applying = false; let stopped = false; let pending: Record<string, unknown> = {}; let scheduled = false;
  let chain = Promise.resolve();
  const values = () => ({ theme: useUi.getState().theme, language: useI18n.getState().lang, appearance: currentAppearance() });
  let accepted = values();
  const apply = (p: SessionInfo["preferences"]) => {
    applying = true;
    try {
      if (p?.theme) useUi.getState().setTheme(p.theme);
      if (p?.language) useI18n.getState().setLang(p.language);
      if (p?.appearance) useAppearance.getState().set(p.appearance);
      accepted = values();
    } finally { applying = false; }
  };
  apply(useSession.getState().preferences);
  const write = (patch: Record<string, unknown>) => {
    if (applying || stopped) return;
    const session = useSession.getState();
    if (!session.enabled) { accepted = values(); return; }
    if (session.offline) { apply({ ...session.preferences!, ...accepted }); toast(getT().offline.onlineRequired, "error"); return; }
    pending = { ...pending, ...patch, ...(patch.appearance ? { appearance: { ...pending.appearance as object, ...patch.appearance as object } } : {}) };
    if (scheduled) return; scheduled = true;
    queueMicrotask(() => {
      scheduled = false; const patch = pending; pending = {}; const owner = session.user?.id;
      chain = chain.then(async () => {
        if (stopped || useSession.getState().user?.id !== owner || useSession.getState().offline) return;
        try {
          const preferences = await accountRequest<NonNullable<SessionInfo["preferences"]>>("/api/account/preferences", patch, "PATCH");
          if (!stopped && useSession.getState().user?.id === owner && !useSession.getState().offline && (preferences.revision ?? 0) >= (useSession.getState().preferences?.revision ?? 0)) useSession.setState({ preferences });
        } catch { if (!stopped) { apply(useSession.getState().preferences); toast(getT().offline.preferenceFailed, "error"); } }
      });
    });
  };
  const subscriptions = [
    useSession.subscribe((s, old) => { if (s.preferences !== old.preferences) apply(s.preferences); }),
    useUi.subscribe((s, old) => { if (s.theme !== old.theme) write({ theme: s.theme }); }),
    useI18n.subscribe((s, old) => { if (s.lang !== old.lang) write({ language: s.lang }); }),
    useAppearance.subscribe((s, old) => {
      const patch: Partial<Appearance> = {};
      for (const key of Object.keys(currentAppearance()) as (keyof Appearance)[]) if (s[key] !== old[key]) Object.assign(patch, { [key]: s[key] });
      if (Object.keys(patch).length) write({ appearance: patch });
    }),
  ];
  return () => { stopped = true; subscriptions.forEach(stop => stop()); };
}
