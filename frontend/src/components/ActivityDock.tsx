import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Cloud, Cpu, Loader2, X } from "lucide-react";
import { QueuePanel } from "@/components/QueuePanel";
import { cn } from "@/lib/utils";
import type { GenerationMeta, Job } from "@/lib/types";

type LightboxItem = { src: string; meta?: GenerationMeta | null };

// ActivityDock — a persistent bottom-right widget summarising in-flight
// generations (cloud/local counts), plus an overlay with the full Activity list.
// Replaces the old Activity *panel*, which could get pushed off-screen when
// stacked under a tall Create panel.
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
  const errors = visible.filter((j) => j.status === "error").length;
  const hasFinished = visible.some((j) => j.status === "done" || j.status === "error");
  const busy = active.length > 0;

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
          <div className="bg-card animate-in fade-in slide-in-from-bottom-2 fixed bottom-[5.25rem] right-6 z-50 flex max-h-[70vh] w-[22rem] max-w-[calc(100vw-3rem)] flex-col rounded-2xl border shadow-2xl duration-200">
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

      {/* Persistent widget — always visible; brand-tinted with a live count while
          runs are in flight, muted otherwise. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("panels.queue")}
        title={busy ? t("activity.busy", { count: active.length }) : t("panels.queue")}
        className={cn(
          "fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full border py-2.5 text-sm font-medium shadow-lg backdrop-blur transition-colors",
          busy ? "brand-surface border-transparent px-3.5 text-white" : "bg-card/90 text-muted-foreground hover:text-foreground hover:bg-card px-3.5",
          open && !busy && "text-foreground"
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
        {busy ? (
          <span className="inline-flex items-center gap-2 tabular-nums">
            {cloudActive > 0 && (
              <span className="inline-flex items-center gap-1">
                <Cloud className="size-3.5" />
                {cloudActive}
              </span>
            )}
            {localActive > 0 && (
              <span className="inline-flex items-center gap-1">
                <Cpu className="size-3.5" />
                {localActive}
              </span>
            )}
          </span>
        ) : (
          <span>{t("panels.queue")}</span>
        )}
        {errors > 0 && (
          <span className="bg-destructive ring-card absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ring-2">
            {errors}
          </span>
        )}
      </button>
    </>
  );
}
