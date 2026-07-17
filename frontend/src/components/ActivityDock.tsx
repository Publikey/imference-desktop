import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Cloud, Cpu, Loader2, X } from "lucide-react";
import { QueuePanel } from "@/components/QueuePanel";
import { cn } from "@/lib/utils";
import type { GenerationMeta, Job } from "@/lib/types";

type LightboxItem = { src: string; meta?: GenerationMeta | null };

// Which discrete event just happened, driving the attention pulse + halo tint.
type PulseKind = "start" | "done" | "error";
const RING_COLOR: Record<PulseKind, string> = {
  start: "var(--brand-from)",
  done: "#22c55e",
  error: "var(--destructive)",
};

// ActivityDock — a persistent bottom-right widget summarising in-flight
// generations (cloud/local counts), plus an overlay with the full Activity list.
// Replaces the old Activity *panel*, which could get pushed off-screen when
// stacked under a tall Create panel. The widget pulses when a run starts,
// finishes, or errors so a background event is noticed.
export function ActivityDock({
  jobs,
  open,
  onOpenChange,
  onDismiss,
  onOpenImage,
  onClear,
}: {
  jobs: Job[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: (id: string) => void;
  onOpenImage: (item: LightboxItem) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const setOpen = (v: boolean | ((o: boolean) => boolean)) =>
    onOpenChange(typeof v === "function" ? v(open) : v);

  const visible = jobs.filter((j) => !j.hidden);
  const active = visible.filter((j) => j.status === "running" || j.status === "queued");
  const cloudActive = active.filter((j) => j.mode === "cloud").length;
  const localActive = active.filter((j) => j.mode === "local").length;
  const doneCount = visible.filter((j) => j.status === "done").length;
  const errors = visible.filter((j) => j.status === "error").length;
  const hasFinished = doneCount + errors > 0;
  const busy = active.length > 0;

  // Detect state transitions (a run added, finished, or failed) and fire a pulse.
  // `pulseId` only ever increments, so keying the pill on it replays the CSS
  // animation cleanly on every event, including two of the same kind in a row.
  const prev = useRef({ active: 0, done: 0, error: 0 });
  const [pulse, setPulse] = useState<{ kind: PulseKind; id: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    let kind: PulseKind | null = null;
    if (errors > p.error) kind = "error";
    else if (doneCount > p.done) kind = "done";
    else if (active.length > p.active) kind = "start";
    prev.current = { active: active.length, done: doneCount, error: errors };
    if (!kind) return;
    setPulse((cur) => ({ kind: kind!, id: (cur?.id ?? 0) + 1 }));
    const to = window.setTimeout(() => setPulse(null), 750);
    return () => window.clearTimeout(to);
  }, [active.length, doneCount, errors]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Overlay — the full Activity list, anchored above the widget. */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="bg-card animate-in fade-in slide-in-from-bottom-2 fixed bottom-[6rem] right-6 z-50 flex max-h-[70vh] w-[22rem] max-w-[calc(100vw-3rem)] flex-col rounded-2xl border shadow-2xl duration-200">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <Activity className="text-muted-foreground size-4" />
              <h2 className="text-sm font-semibold">{t("panels.queue")}</h2>
              {busy && (
                <span className="brand-surface flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white">
                  {active.length}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {hasFinished && (
                  <button
                    type="button"
                    onClick={onClear}
                    className="text-muted-foreground/60 hover:text-foreground text-[11px] font-medium transition-colors"
                  >
                    {t("queue.clearFinished")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t("common.close")}
                  className="text-muted-foreground/60 hover:text-foreground rounded p-0.5 transition-colors"
                >
                  <X className="size-4" />
                </button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <QueuePanel
                jobs={jobs}
                onDismiss={onDismiss}
                onOpenImage={(i) => {
                  onOpenImage(i);
                  setOpen(false);
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* Persistent widget — a prominent floating pill: brand-tinted with a live
          cloud/local count while runs are in flight, solid card otherwise. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("panels.queue")}
        title={busy ? t("activity.busy", { count: active.length }) : t("panels.queue")}
        className="fixed bottom-6 right-6 z-40 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {/* One-shot halo behind the pill, keyed so it replays on every event. */}
        {pulse && (
          <span
            key={pulse.id}
            aria-hidden
            className="dock-ring pointer-events-none absolute inset-0 rounded-2xl"
            style={{ "--dock-ring": RING_COLOR[pulse.kind] } as CSSProperties}
          />
        )}
        <span
          key={pulse?.id ?? 0}
          className={cn(
            "relative flex items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-xl backdrop-blur transition-colors",
            busy
              ? "brand-surface border-transparent text-white"
              : "bg-card text-foreground hover:border-[var(--brand-from)]/40",
            pulse && "dock-pop"
          )}
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Activity className="size-5 text-[var(--brand-from)]" />
          )}
          {busy ? (
            <span className="inline-flex items-center gap-2.5 tabular-nums">
              {cloudActive > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Cloud className="size-4" />
                  {cloudActive}
                </span>
              )}
              {localActive > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Cpu className="size-4" />
                  {localActive}
                </span>
              )}
            </span>
          ) : (
            <span>{t("panels.queue")}</span>
          )}
          {errors > 0 && (
            <span className="bg-destructive ring-card absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold text-white ring-2">
              {errors}
            </span>
          )}
        </span>
      </button>
    </>
  );
}
