import { create } from "zustand";
import type { OfflineSummary } from "../lib/offlineStore";
export interface DownloadProgress { id: string; title: string; status: "queued" | "downloading" | "ready" | "failed"; bytes: number; total: number | null; }
export const useOffline = create<{ progress: DownloadProgress[]; summary: OfflineSummary | null; busy: boolean; error: string; siteUsage: number | null; persistent: boolean | null }>(() => ({ progress: [], summary: null, busy: false, error: "", siteUsage: null, persistent: null }));
