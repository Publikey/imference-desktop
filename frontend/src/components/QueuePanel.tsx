import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Clock, Cloud, Copy, Cpu, Loader2, Sparkles, Square, X } from "lucide-react";
import { ProgressBar } from "@/components/ui/progress";
import { HoverPopover } from "@/components/ui/hover-popover";
import { cn } from "@/lib/utils";
import { ToolIcon } from "@/components/ToolBits";
import { KNOWN_STAGES } from "@/lib/tools";
import { AgentBadge } from "@/components/AgentBadge";
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
  onStop,
  onOpenImage,
}: {
  jobs: Job[];
  onDismiss: (id: string) => void;
  onStop: (job: Job) => void;
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
      // One quiet row: an empty dock has nothing to show, so it takes little room.
      <div className="flex items-center gap-3 rounded-xl border border-dashed px-3 py-3 text-left">
        <div className="brand-surface flex size-8 shrink-0 items-center justify-center rounded-lg text-white">
          <Sparkles className="size-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <p className="text-foreground text-xs font-medium">{t("queue.empty")}</p>
          <p className="text-muted-foreground text-2xs leading-snug">{t("queue.emptyHint")}</p>
        </div>
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
          onStop={onStop}
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
  onStop,
  onOpenImage,
}: {
  job: Job;
  now: number;
  position?: number;
  onDismiss: (id: string) => void;
  onStop: (job: Job) => void;
  onOpenImage: (item: LightboxItem) => void;
}) {
  const { t } = useTranslation();
  const running = job.status === "running";
  const queued = job.status === "queued";
  const pct = job.progress && job.progress.total > 0 ? job.progress.percent : null;
  // Elapsed only makes sense once a job has actually started (startedAt set).
  const elapsed = job.startedAt ? fmtElapsed((job.endedAt ?? now) - job.startedAt) : "";
  const ModeIcon = job.mode === "cloud" ? Cloud : Cpu;
  const isTool = job.kind === "tool";
  // A tool run reports named stages (no step counter) and shows its saved
  // output as the thumbnail.
  const thumb = isTool ? job.tool?.preview : job.image?.imageBase64;
  const toolPct = isTool && job.tool?.fraction ? job.tool.fraction * 100 : null;

  const toolText = isTool ? job.tool?.result?.outputs.find((o) => o.type === "text" && o.text)?.text : undefined;
  const statusLine = isTool && job.status === "done" && toolText
    ? toolText
    : isTool && running
    ? t(`tools.stage.${KNOWN_STAGES.has(job.tool?.stage ?? "") ? job.tool!.stage : "running"}`)
    : queued
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
      data-mode={job.mode}
      className={cn(
        // The mode the job ran in, as a left edge (Local blue / Cloud cyan).
        "ds-card rise-in mode-edge group relative border-l-[3px] p-2.5 transition-colors",
        job.status === "error" && "border-destructive/30 bg-destructive/5",
        queued && "border-dashed"
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Leading visual: image once done, else a state glyph (ring while
            denoising, spinner while cloud-running, clock while queued). */}
        {job.status === "done" && thumb ? (
          <button
            type="button"
            onClick={() => onOpenImage({ src: thumb, meta: job.image?.meta ?? null })}
            className="focus-visible:ring-ring/50 shrink-0 overflow-hidden rounded-lg outline-none transition-transform focus-visible:ring-2 active:scale-95"
          >
            {thumb.startsWith("data:video/") ? (
              // Video result — a muted looping micro-preview as the thumbnail.
              <video src={thumb} muted loop autoPlay playsInline className="size-10 object-cover" />
            ) : (
              <img src={thumb} alt="" className="checkerboard size-10 object-cover" />
            )}
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
            {isTool && !running && job.status !== "error" ? (
              <ToolIcon id={job.tool?.toolId ?? ""} className="size-4" />
            ) : queued ? (
              <Clock className="size-4" />
            ) : running ? (
              // One progress language: the glyph is just a spinner; the actual
              // percent/step lives in the linear bar + status line below.
              <Loader2 className="size-4 animate-spin" />
            ) : job.status === "error" ? (
              <AlertCircle className="size-4" />
            ) : (
              <Check className="size-4" />
            )}
          </span>
        )}

        <div className="min-w-0 flex-1">
          {/* The title moved off the <li> and onto the prompt: it describes the
              prompt, and leaving it on the row made a second, slower tooltip
              race the error popover below. */}
          <p
            className={cn("truncate text-xs font-medium leading-5", queued && "text-muted-foreground")}
            title={job.prompt}
          >
            {job.prompt}
          </p>
          <p
            className={cn(
              "mt-0.5 flex items-center gap-1.5 text-2xs tabular-nums",
              job.status === "error" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            <ModeIcon className="size-3 shrink-0" />
            {/* Engine and cloud errors run long and are the one thing worth
                reading in full — reveal what the truncation cut off. */}
            <HoverPopover content={job.status === "error" ? job.error ?? "" : toolText ?? ""} className="truncate">
              {job.status === "error" ? job.error : statusLine}
            </HoverPopover>
            {running && elapsed && (
              <span className="text-muted-foreground/60 ml-auto shrink-0">{elapsed}</span>
            )}
          </p>
          {job.via !== undefined && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <AgentBadge via={job.via} />
              {job.modelName && (
                <span className="text-muted-foreground truncate text-2xs" title={job.modelName}>
                  {job.modelName}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Trailing action: STOP a running local run (hard-restarts the engine),
            CANCEL a queued one, or DISMISS a finished/failed row. A running cloud
            run can't be stopped (the request is already in flight server-side);
            a RESUMED one gets an X that only forgets its stuck pending record. */}
        {running ? (
          job.mode === "local" || isTool ? (
            <button
              type="button"
              onClick={() => onStop(job)}
              aria-label={t("queue.stop")}
              title={t("queue.stop")}
              // Always visible (not hover-gated): a running job must be stoppable
              // without hunting for the control.
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 -mr-0.5 -mt-0.5 rounded p-1 transition-colors"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : job.resumed ? (
            <button
              type="button"
              onClick={() => onStop(job)}
              aria-label={t("queue.dismiss")}
              title={t("queue.dismiss")}
              // Hover-gated like the other dismiss: this is a rescue for a stuck
              // row, not a control you should reach for on a healthy run.
              className="text-muted-foreground/40 hover:text-foreground -mr-0.5 -mt-0.5 rounded p-1 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          ) : null
        ) : (
          <>
          {toolText && (
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(toolText).catch(() => {})}
              aria-label={t("common.copy")}
              title={t("common.copy")}
              className="text-muted-foreground/60 hover:text-foreground -mt-0.5 rounded p-1 transition-colors"
            >
              <Copy className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(job.id)}
            aria-label={queued ? t("queue.cancel") : t("queue.dismiss")}
            title={queued ? t("queue.cancel") : t("queue.dismiss")}
            className="text-muted-foreground/40 hover:text-foreground -mr-0.5 -mt-0.5 rounded p-1 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
          </>
        )}
      </div>

      {/* Progress: determinate brand bar for local steps, sweeping pulse for cloud. */}
      {running && <ProgressBar percent={isTool ? toolPct : pct} height="h-1" className="mt-2" />}
    </li>
  );
}
