import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, AlertCircle, Check, Cloud, Copy, Cpu, Loader2, RefreshCw, X } from "lucide-react";
import { QueuePanel } from "@/components/QueuePanel";
import { ToolIcon } from "@/components/ToolBits";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
  onStop,
  onRecheck,
  onOpenImage,
  onClear,
}: {
  jobs: Job[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: (id: string) => void;
  onStop: (job: Job) => void;
  onRecheck: () => void;
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

  // Finish notices: each run that ends (generation, tool) pops a small card out
  // of the widget for a few seconds — the gallery may be hidden or off-screen,
  // so this is the one place a background result is always seen. A click opens
  // the result: the image (viewer), the text (reader) or, on failure, the list.
  const seen = useRef<Map<string, Job["status"]> | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [textView, setTextView] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = new Map(jobs.map((j) => [j.id, j.status]));
    // First render: rows rehydrated at launch are history, not news.
    if (!before) return;
    const ended = jobs.filter((j) => {
      if (j.hidden || (j.status !== "done" && j.status !== "error")) return false;
      const was = before.get(j.id);
      return was !== "done" && was !== "error";
    });
    // The open list already shows it.
    if (ended.length === 0 || open) return;
    const ids = ended.map((j) => j.id);
    setNotices((cur) => [...ids, ...cur.filter((id) => !ids.includes(id))].slice(0, 3));
  }, [jobs, open]);
  // Opening the list covers every pending notice.
  useEffect(() => {
    if (open) setNotices([]);
  }, [open]);
  const dropNotice = (id: string) => setNotices((cur) => cur.filter((n) => n !== id));
  const openNotice = (job: Job) => {
    dropNotice(job.id);
    const r = noticeResult(job);
    if (r.kind === "image") onOpenImage({ src: r.src, meta: job.image?.meta ?? null });
    else if (r.kind === "text") setTextView({ title: job.prompt, text: r.text });
    else setOpen(true);
  };

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
                {cloudActive > 0 && (
                  <button
                    type="button"
                    onClick={onRecheck}
                    title={t("queue.recheck")}
                    className="text-muted-foreground/60 hover:text-foreground inline-flex items-center gap-1 text-[11px] font-medium transition-colors"
                  >
                    <RefreshCw className="size-3" />
                    {t("queue.recheck")}
                  </button>
                )}
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
                onStop={onStop}
                onOpenImage={(i) => {
                  onOpenImage(i);
                  setOpen(false);
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* The widget and, to its left, the finish notices popping out of it. */}
      <div className="pointer-events-none fixed bottom-6 right-6 z-40 flex flex-row-reverse items-end gap-3">
      {/* Persistent widget — a prominent floating pill: brand-tinted with a live
          cloud/local count while runs are in flight, solid card otherwise. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("panels.queue")}
        title={busy ? t("activity.busy", { count: active.length }) : t("panels.queue")}
        className="pointer-events-auto relative shrink-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-from)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {/* One-shot halo behind the pill, keyed so it replays on every event.
            The halo and the pill are siblings, so their keys are namespaced —
            the bare pulse id on both made every pulse a duplicate-key warning. */}
        {pulse && (
          <span
            key={`halo-${pulse.id}`}
            aria-hidden
            className="dock-ring pointer-events-none absolute inset-0 rounded-2xl"
            style={{ "--dock-ring": RING_COLOR[pulse.kind] } as CSSProperties}
          />
        )}
        <span
          key={`pill-${pulse?.id ?? 0}`}
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
      {notices.length > 0 && (
        <div className="flex max-w-[calc(100vw-12rem)] flex-col-reverse items-end gap-2" aria-live="polite">
          {notices.map((id) => {
            const job = jobs.find((j) => j.id === id);
            return job ? (
              <FinishNotice key={id} job={job} onOpen={() => openNotice(job)} onDismiss={() => dropNotice(id)} />
            ) : null;
          })}
        </div>
      )}
      </div>

      {/* A text result (Describe…) in full, with a copy button. */}
      <Dialog open={!!textView} onOpenChange={(o) => !o && setTextView(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate text-base">{textView?.title}</DialogTitle>
          </DialogHeader>
          <p className="bg-muted/40 max-h-[50vh] select-text overflow-y-auto whitespace-pre-wrap rounded-lg border p-3 text-sm leading-relaxed">
            {textView?.text}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(textView?.text ?? "").catch(() => {})}
            >
              <Copy className="size-4" />
              {t("common.copy")}
            </Button>
            <Button onClick={() => setTextView(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type NoticeResult = { kind: "image"; src: string } | { kind: "text"; text: string } | { kind: "list" };

/** What a click on a finish notice opens. */
function noticeResult(job: Job): NoticeResult {
  if (job.status !== "done") return { kind: "list" };
  if (job.kind === "tool") {
    const text = job.tool?.result?.outputs.find((o) => o.type === "text" && o.text)?.text;
    if (job.tool?.preview) return { kind: "image", src: job.tool.preview };
    if (text) return { kind: "text", text };
    return { kind: "list" };
  }
  return job.image?.imageBase64 ? { kind: "image", src: job.image.imageBase64 } : { kind: "list" };
}

/** One finish notice: shown ~7 s (paused while hovered), then gone. The
 *  countdown is the bar's CSS animation, so hover-pause is just its play state. */
function FinishNotice({ job, onOpen, onDismiss }: { job: Job; onOpen: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const r = noticeResult(job);
  const failed = job.status === "error";
  const sub = failed
    ? job.error || t("queue.failed")
    : r.kind === "text"
      ? r.text
      : t(r.kind === "image" ? "activity.noticeOpen" : "activity.noticeShow");
  return (
    <div
      data-mode={job.mode}
      className={cn(
        "notice-pop bg-card mode-edge group pointer-events-auto relative flex w-80 max-w-full items-center gap-2.5 overflow-hidden rounded-2xl border border-l-[3px] p-2 pr-8 shadow-xl",
        failed && "border-destructive/40"
      )}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none">
        {r.kind === "image" ? (
          r.src.startsWith("data:video/") ? (
            <video src={r.src} muted loop autoPlay playsInline className="size-12 shrink-0 rounded-lg object-cover" />
          ) : (
            <img src={r.src} alt="" className="checkerboard size-12 shrink-0 rounded-lg object-cover" />
          )
        ) : (
          <span
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-lg border",
              failed ? "border-destructive/30 text-destructive" : "bg-muted/50 text-muted-foreground"
            )}
          >
            {failed ? (
              <AlertCircle className="size-5" />
            ) : job.kind === "tool" ? (
              <ToolIcon id={job.tool?.toolId ?? ""} className="size-5" />
            ) : (
              <Check className="size-5" />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-[11px] font-semibold",
              failed ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
            )}
          >
            {failed ? t("activity.noticeFailed") : t("activity.noticeDone")}
          </span>
          <span className="block truncate text-xs font-medium" title={job.prompt}>
            {job.prompt}
          </span>
          <span className="text-muted-foreground line-clamp-2 text-[11px] leading-snug">{sub}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("queue.dismiss")}
        className="text-muted-foreground/60 hover:text-foreground absolute right-1.5 top-1.5 rounded p-0.5"
      >
        <X className="size-3.5" />
      </button>
      <span
        aria-hidden
        onAnimationEnd={onDismiss}
        className={cn(
          "notice-timer absolute bottom-0 left-0 h-0.5 w-full",
          failed ? "bg-destructive/60" : "bg-[var(--brand-from)]/60"
        )}
      />
    </div>
  );
}
