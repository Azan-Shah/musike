import { useState } from "react";
import { SessionCache } from "../lib/sessionCache";

const pages = new SessionCache<object | string, number>(60, 30 * 60_000);
export const ROWS_PER_PAGE = 100;

/** Bound mounted rows, preserving the page when the same collection is revisited. */
export function useListPage<T>(items: T[], identity: object | string = items, pageSize = ROWS_PER_PAGE) {
  const [state, setState] = useState(() => ({ identity, page: pages.get(identity) ?? 0 }));
  const requested = state.identity === identity ? state.page : pages.get(identity) ?? 0;
  const page = Math.min(requested, Math.max(0, Math.ceil(items.length / pageSize) - 1));
  const start = page * pageSize;
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(page + delta, Math.ceil(items.length / pageSize) - 1));
    pages.set(identity, next);
    setState({ identity, page: next });
  };
  return { start, end: Math.min(start + pageSize, items.length), items: items.slice(start, start + pageSize),
    previous: () => move(-1), next: () => move(1) };
}
