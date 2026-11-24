import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useT } from "../i18n";

export function ListPager({ start, end, total, previous, next, compact = false }: {
  start: number; end: number; total: number; previous: () => void; next: () => void; compact?: boolean;
}) {
  const t = useT().trackList;
  if (start === 0 && end >= total) return null;
  const button = compact ? "button-secondary size-7 shrink-0 px-0" : "button-secondary";
  return <div className={compact ? "flex flex-wrap items-center justify-center gap-1 py-2" : "flex flex-wrap items-center justify-center gap-3 py-4"}>
    <button type="button" className={button} disabled={start === 0} onClick={previous} aria-label={t.previous}>
      {compact ? <CaretLeftIcon size={14} /> : t.previous}
    </button>
    <span className={compact ? "sr-only" : "text-sm text-fg-2"} role="status">{t.pageRange(start + 1, end, total)}</span>
    <button type="button" className={button} disabled={end >= total} onClick={next} aria-label={t.next}>
      {compact ? <CaretRightIcon size={14} /> : t.next}
    </button>
  </div>;
}
