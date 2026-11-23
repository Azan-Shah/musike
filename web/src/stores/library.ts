import { offlineOwner, snapshotOfflineLibrary } from "../lib/offlineDownloads";
import { getT } from "../i18n";
import { api } from "../lib/api";
import { createLibraryStore } from "./libraryState";
import { toast } from "./ui";

export const useLibrary = createLibraryStore(api, getT, toast);

let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
useLibrary.subscribe((state, previous) => {
  if (state.status !== "ready" || state.favorites === previous.favorites && state.playlists === previous.playlists && state.history === previous.history && previous.status === "ready") return;
  clearTimeout(snapshotTimer); const owner = offlineOwner();
  snapshotTimer = setTimeout(() => { if (!owner || offlineOwner() !== owner) return; const latest = useLibrary.getState(); void snapshotOfflineLibrary({ favorites: latest.favorites, playlists: latest.playlists, history: latest.history }); }, 500);
});
