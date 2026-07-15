import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Clock, Cloud, Cpu, Loader2, Wind, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GenerationMeta, Job } from "@/lib/types";

// ---------------------------------------------------------------------------
// QueuePanel — the Activity panel: every generation in flight (local or cloud)
// with live progress + elapsed time, plus this session's finished/failed runs.
// Finished images also live in the gallery; dismissing a row here never
// removes the image there.
// ---------------------------------------------------------------------------

type LightboxItem = { src: string; meta?: GenerationMeta | null };

/** 1 Hz clock, ticking only while something runs (drives the elapsed labels). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

export function QueuePanel({
  jobs,
  onDismiss,
  onOpenImage,
}: {
  jobs: Job[];
  onDismiss: (id: string) => void;
  onOpenImage: (item: LightboxItem) => void;
}) {
  const { t } = useTranslation();
  const visible = jobs.filter((j) => !j.hidden);
  const anyRunning = visible.some((j) => j.status === "running");
  const now = useNow(anyRunning);

  // 1-based position in the local queue (oldest waits at #1). `visible` is
  // newest-first, so the oldest queued job gets the lowest number.
  const queuePos = new Map<string, number>();
  let pos = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].status === "queued") queuePos.set(visible[i].id, ++pos);
  }

  if (visible.length === 0) {
    return (
      <div className="bg-card/60 text-muted-foreground/70 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-10 text-center backdrop-blur-sm">
        <Wind className="size-5" strokeWidth={1.75} />
        <p className="text-xs font-medium">{t("queue.empty")}</p>
        <p className="text-muted-foreground/50 text-[11px] leading-snug">{t("queue.emptyHint")}</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((job) => (
        <QueueRow
          key={job.id}
          job={job}
          now={now}
          position={queuePos.get(job.id)}
          onDismiss={onDismiss}
          onOpenImage={onOpenImage}
        />
      ))}
    </ul>
  );
}

function QueueRow({
  job,
  now,
  position,
  onDismiss,
  onOpenImage,
}: {
  job: Job;
  now: number;
  position?: number;
  onDismiss: (id: string) => void;
  onOpenImage: (item: LightboxItem) => void;
}) {
  const { t } = useTranslation();
  const running = job.status === "running";
  const queued = job.status === "queued";
  const pct = job.progress && job.progress.total > 0 ? job.progress.percent : null;
  // Elapsed only makes sense once a job has actually started (startedAt set).
  const elapsed = job.startedAt ? fmtElapsed((job.endedAt ?? now) - job.startedAt) : "";
  const ModeIcon = job.mode === "cloud" ? Cloud : Cpu;

  const statusLine = queued
    ? position && position > 1
      ? t("queue.queuedPosition", { position })
      : t("queue.queuedNext")
    : running
      ? pct !== null
        ? t("queue.step", { step: job.progress!.step, total: job.progress!.total })
        : job.mode === "cloud"
          ? t("queue.cloudRunning")
          : t("queue.generating")
      : job.status === "done"
        ? t("queue.done", { time: elapsed })
        : t("queue.failed");

  return (
    <li
      className={cn(
        "rise-in bg-card group relative rounded-2xl border p-2.5 shadow-sm transition-colors",
        job.status === "error" && "border-destructive/30 bg-destructive/5",
        queued && "border-dashed"
      )}
      title={job.prompt}
    >
      <div className="flex items-start gap-2.5">
        {/* Leading visual: image once done, else a state glyph (ring while
            denoising, spinner while cloud-running, clock while queued). */}
        {job.status === "done" && job.image ? (
          <button
            type="button"
            onClick={() => onOpenImage({ src: job.image!.imageBase64, meta: job.image!.meta })}
            className="focus-visible:ring-ring/50 shrink-0 overflow-hidden rounded-lg outline-none transition-transform focus-visible:ring-2 active:scale-95"
          >
            <img src={job.image.imageBase64} alt="" className="size-10 object-cover" />
          </button>
        ) : (
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg border",
              job.status === "error"
                ? "border-destructive/30 text-destructive"
                : "border-border/60 bg-muted/50 text-muted-foreground"
            )}
          >
            {queued ? (
              <Clock className="size-4" />
            ) : running ? (
              pct !== null ? (
                <ProgressRing percent={pct} />
              ) : (
                <Loader2 className="size-4 animate-spin" />
              )
            ) : job.status === "error" ? (
              <AlertCircle className="size-4" />
            ) : (
              <Check className="size-4" />
            )}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-xs font-medium leading-5", queued && "text-muted-foreground")}>
            {job.prompt}
          </p>
          <p
            className={cn(
              "mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums",
              job.status === "error" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            <ModeIcon className="size-3 shrink-0" />
            <span className="truncate">{job.status === "error" ? job.error : statusLine}</span>
            {running && elapsed && (
              <span className="text-muted-foreground/60 ml-auto shrink-0">{elapsed}</span>
            )}
          </p>
        </div>

        {/* Dismiss — cancels a queued job or clears a finished one. A running job
            can't be cancelled yet (no sidecar cancel API). */}
        {!running && (
          <button
            type="button"
            onClick={() => onDismiss(job.id)}
            aria-label={queued ? t("queue.cancel") : t("queue.dismiss")}
            title={queued ? t("queue.cancel") : t("queue.dismiss")}
            className="text-muted-foreground/40 hover:text-foreground -mr-0.5 -mt-0.5 rounded p-1 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Progress: determinate brand bar for local steps, sweeping pulse for cloud. */}
      {running && (
        <div className="bg-muted mt-2 h-1 w-full overflow-hidden rounded-full">
          {pct !== null ? (
            <div
              className="brand-surface h-full rounded-full transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="bar-indeterminate h-full w-full" />
          )}
        </div>
      )}
    </li>
  );
}

/** Tiny circular progress — the running job's leading visual. */
function ProgressRing({ percent }: { percent: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * c;
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-border" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        className="stroke-[var(--brand-to)] transition-[stroke-dasharray] duration-300 ease-out"
      />
    </svg>
  );
}
