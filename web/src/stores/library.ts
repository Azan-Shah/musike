import { offlineOwner, snapshotOfflineLibrary } from "../lib/offlineDownloads";
import { offlineEnabled, saveOfflineHistory } from "../lib/offlineStore";
import { getT } from "../i18n";
import { api } from "../lib/api";
import { createLibraryStore } from "./libraryState";
import { useOffline } from "./offline";
import { useSession } from "./session";
import { toast } from "./ui";

export const useLibrary = createLibraryStore(api, getT, toast);

let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotRequest: AbortController | undefined;

function cancelSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotRequest?.abort();
}

function onlineOwner() {
  const owner = offlineOwner();
  const session = useSession.getState();
  return !session.offline && owner && owner === session.user?.id ? owner : null;
}

/** Refresh the complete offline snapshot only on opted-in installations, after the index can render. */
export async function syncOfflineLibrary() {
  cancelSnapshot();
  const owner = onlineOwner();
  if (!owner || typeof indexedDB === "undefined") return;
  const request = new AbortController();
  snapshotRequest = request;
  const current = () => !request.signal.aborted && onlineOwner() === owner;
  try {
    if (!await offlineEnabled(owner) || !current()) return;
    const history = useLibrary.getState().confirmedHistory;
    const library = await api.library(request.signal);
    if (!current()) return;
    const latestHistory = useLibrary.getState().confirmedHistory;
    await snapshotOfflineLibrary(latestHistory === history ? library : { ...library, history: latestHistory });
  } catch {
    if (current()) useOffline.setState({ error: getT().offline.metadataUnavailable });
  } finally {
    if (snapshotRequest === request) snapshotRequest = undefined;
  }
}

useSession.subscribe((state, previous) => {
  if (state.enabled === previous.enabled && state.user?.id === previous.user?.id && !!state.offline === !!previous.offline) return;
  cancelSnapshot();
  useLibrary.getState().reset();
});

useLibrary.subscribe((state, previous) => {
  const owner = onlineOwner();
  if (!owner || state.status !== "ready" || typeof indexedDB === "undefined") return;
  if (state.snapshotRevision !== previous.snapshotRevision || previous.status !== "ready") {
    cancelSnapshot();
    snapshotTimer = setTimeout(() => { if (onlineOwner() === owner) void syncOfflineLibrary(); }, 1000);
  } else if (state.confirmedHistory !== previous.confirmedHistory) {
    void saveOfflineHistory(owner, state.confirmedHistory).catch(() => {
      if (onlineOwner() === owner) useOffline.setState({ error: getT().offline.metadataUnavailable });
    });
  }
});
