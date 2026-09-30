import { ComposerCardHeader } from "@/components/ComposerCard";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Play,
  Square,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ProgressBar } from "@/components/ui/progress";
import type {
  ComponentsProgress,
  ComponentsReadiness,
  InstallProgress,
  ModelInfo,
  SidecarStatus,
} from "@/lib/types";

// LocalReadinessCard — the ONE place that says whether the selected local
// model can generate, and hosts every action to get there. Replaces three
// scattered affordances (engine start in the header, components download under
// the model name, weights download hijacking the Generate button) with a
// three-row preflight checklist:
//
//   1. model weights   — on disk?  → download (with progress)
//   2. shared components — in the offline tree? → download (with progress)
//   3. local engine    — installed & running? → install / start / stop
//
// Rows are INDEPENDENT and their actions run in parallel (downloads +
// engine boot deliberately overlap; the engine only reads the tree at model
// load). "Prepare all" fires everything missing at once and auto-starts the
// engine when the downloads land. Once everything is green the card collapses
// to a single ✓ line (click to expand).
type Props = {
  model: ModelInfo | null;
  // Engine row
  engineInstalled: boolean;
  installing: boolean;
  sidecar: SidecarStatus;
  onInstallEngine: () => void;
  onStartEngine: () => void;
  onStopEngine: () => void;
  // Weights row
  weightsCached: boolean;
  weightsDownloading: boolean;
  weightsIsLoad: boolean; // activation of cached weights (no fetch to cancel)
  weightsProgress: InstallProgress | null;
  onDownloadWeights: () => void;
  onCancelWeights: () => void;
  // Components row
  componentsReadiness: ComponentsReadiness | null;
  componentsProgress: ComponentsProgress | null;
  componentsDownloading: boolean;
  componentsChecking: boolean;
  componentsError: string | null;
  onDownloadComponents: () => void;
};

export function LocalReadinessCard({
  model,
  engineInstalled,
  installing,
  sidecar,
  onInstallEngine,
  onStartEngine,
  onStopEngine,
  weightsCached,
  weightsDownloading,
  weightsIsLoad,
  weightsProgress,
  onDownloadWeights,
  onCancelWeights,
  componentsReadiness,
  componentsProgress,
  componentsDownloading,
  componentsChecking,
  componentsError,
  onDownloadComponents,
}: Props) {
  const { t } = useTranslation();

  // Row verdicts. Components: only a POSITIVE "files missing" blocks — an
  // unknown readiness (no base repo, no manifest, check failed) counts green
  // with the engine's lazy path as the safety net.
  const componentsBlocked =
    !!componentsReadiness && componentsReadiness.hasManifest && !componentsReadiness.ready;
  const componentsOk = !componentsBlocked && !componentsChecking && !componentsDownloading && !componentsError;
  const weightsOk = weightsCached && !weightsDownloading;
  const engineOk = engineInstalled && sidecar.state === "ready";
  const allReady = !!model && weightsOk && componentsOk && engineOk;

  // Collapse when green; auto-expand the moment anything regresses.
  const [expanded, setExpanded] = useState(!allReady);
  useEffect(() => {
    if (!allReady) setExpanded(true);
  }, [allReady]);

  // "Prepare all": fire every missing step now, and remember to auto-start the
  // engine once the downloads land (the one bit of chaining a single click
  // deserves). The flag survives re-renders but not a model switch.
  const autoStartArmed = useRef(false);
  useEffect(() => {
    autoStartArmed.current = false;
  }, [model?.modelCode]);
  useEffect(() => {
    if (!autoStartArmed.current) return;
    if (weightsOk && componentsOk && engineInstalled && sidecar.state === "stopped") {
      autoStartArmed.current = false;
      onStartEngine();
    }
  }, [weightsOk, componentsOk, engineInstalled, sidecar.state, onStartEngine]);

  if (!model) return null;

  const pendingActions =
    (!weightsOk && !weightsDownloading ? 1 : 0) +
    (componentsBlocked && !componentsDownloading ? 1 : 0) +
    (engineInstalled && sidecar.state === "stopped" ? 1 : 0) +
    (!engineInstalled && !installing ? 1 : 0);

  const prepareAll = () => {
    if (!weightsOk && !weightsDownloading) onDownloadWeights();
    if (componentsBlocked && !componentsDownloading) onDownloadComponents();
    if (!engineInstalled && !installing) onInstallEngine();
    if (engineInstalled && sidecar.state === "stopped") {
      if (weightsOk && componentsOk) onStartEngine();
      else autoStartArmed.current = true; // start as soon as the downloads land
    }
  };

  if (allReady && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="bg-card hover:border-primary/30 flex w-full items-center gap-2 rounded-2xl border px-4 py-2.5 text-left text-xs shadow-sm transition"
      >
        <Check className="size-3.5 shrink-0 text-emerald-500" />
        <span className="min-w-0 flex-1 truncate">
          {t("readiness.readyLine", { name: model.name })}
        </span>
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
      </button>
    );
  }

  return (
    <section className="bg-card grid gap-2.5 rounded-2xl border px-4 py-3 text-xs shadow-sm">
      <div className="flex items-center justify-between">
        <ComposerCardHeader title={t("readiness.title")} help={t("readiness.help")} />
        <div className="flex items-center gap-2">
          {pendingActions > 1 && (
            <button
              type="button"
              onClick={prepareAll}
              className="border-primary/40 text-primary hover:bg-primary/10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition-colors"
            >
              <Download className="size-3" />
              {t("readiness.prepareAll")}
            </button>
          )}
          {allReady && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground"
              title={t("common.close")}
            >
              <ChevronUp className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Row 1 — model weights */}
      <Row
        ok={weightsOk}
        busy={weightsDownloading}
        label={t("readiness.weights")}
        okText={
          model.localPath
            ? t("readiness.weightsLocalFile")
            : t("readiness.weightsCached")
        }
      >
        {weightsDownloading && weightsProgress ? (
          <BusyLine
            text={
              weightsIsLoad
                ? t("readiness.weightsLoading")
                : weightsProgress.messageKey
                  ? t(weightsProgress.messageKey, {
                      ...weightsProgress.messageArgs,
                      defaultValue: weightsProgress.message,
                    })
                  : weightsProgress.message || t("readiness.weightsDownloading")
            }
            percent={weightsProgress.percentEstimate > 0 ? weightsProgress.percentEstimate : null}
            onCancel={weightsIsLoad ? undefined : onCancelWeights}
            cancelLabel={t("common.cancel")}
          />
        ) : weightsProgress?.error ? (
          <ErrorLine
            text={
              weightsProgress.messageKey
                ? t(weightsProgress.messageKey, {
                    ...weightsProgress.messageArgs,
                    defaultValue: weightsProgress.error,
                  })
                : weightsProgress.error
            }
            onRetry={onDownloadWeights}
            retryLabel={t("common.retry")}
          />
        ) : !weightsOk ? (
          <ActionButton onClick={onDownloadWeights} label={t("readiness.download")} />
        ) : null}
      </Row>

      {/* Row 2 — shared base components */}
      <Row
        ok={componentsOk}
        busy={componentsDownloading || componentsChecking}
        label={t("readiness.components")}
        okText={
          componentsReadiness?.hasManifest
            ? t("readiness.componentsOk")
            : t("readiness.componentsNone")
        }
      >
        {componentsChecking ? (
          <BusyLine text={t("modelBar.componentsChecking")} percent={null} />
        ) : componentsDownloading && componentsProgress ? (
          <BusyLine
            text={t("modelBar.componentsDownloading", {
              index: componentsProgress.fileIndex,
              total: componentsProgress.totalFiles,
              file: componentsProgress.file.split("/").pop() ?? componentsProgress.file,
            })}
            percent={componentsProgress.totalBytes > 0 ? componentsProgress.percent : null}
          />
        ) : componentsError ? (
          <ErrorLine text={componentsError} onRetry={onDownloadComponents} retryLabel={t("common.retry")} />
        ) : componentsBlocked ? (
          <ActionButton
            onClick={onDownloadComponents}
            label={t("readiness.downloadSized", {
              size: humanBytes(componentsReadiness?.missingBytes ?? 0),
            })}
          />
        ) : null}
      </Row>

      {/* Row 3 — local engine */}
      <Row
        ok={engineOk}
        busy={installing || sidecar.state === "starting"}
        label={t("readiness.engine")}
        okText={t("readiness.engineRunning")}
      >
        {!engineInstalled ? (
          installing ? (
            <BusyLine text={t("readiness.engineInstalling")} percent={null} />
          ) : (
            <ActionButton onClick={onInstallEngine} label={t("engineControl.install")} />
          )
        ) : sidecar.state === "starting" ? (
          <BusyLine text={t("readiness.engineStarting")} percent={null} />
        ) : sidecar.state === "error" ? (
          <ErrorLine
            text={sidecar.message || t("readiness.engineError")}
            onRetry={onStartEngine}
            retryLabel={t("engineControl.start")}
          />
        ) : sidecar.state === "ready" ? (
          <button
            type="button"
            onClick={onStopEngine}
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-medium transition-colors"
          >
            <Square className="size-3" /> {t("engineControl.stop")}
          </button>
        ) : (
          <ActionButton onClick={onStartEngine} label={t("engineControl.start")} icon="play" />
        )}
      </Row>
    </section>
  );
}

// One checklist row: status icon + label on the left, state/action on the right.
function Row({
  ok,
  busy,
  label,
  okText,
  children,
}: {
  ok: boolean;
  busy: boolean;
  label: string;
  okText: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2.5">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border",
          ok
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
            : busy
              ? "border-primary/40 text-primary"
              : "border-muted-foreground/30 text-muted-foreground"
        )}
      >
        {ok ? (
          <Check className="size-3" />
        ) : busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Download className="size-3 opacity-60" />
        )}
      </span>
      <span className="w-40 shrink-0 font-medium">{label}</span>
      <div className="min-w-0 flex-1">
        {ok && !children ? (
          <span className="text-muted-foreground">{okText}</span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  label,
  icon = "download",
}: {
  onClick: () => void;
  label: string;
  icon?: "download" | "play";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-primary/40 text-primary hover:bg-primary/10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition-colors"
    >
      {icon === "play" ? <Play className="size-3" /> : <Download className="size-3" />}
      {label}
    </button>
  );
}

function BusyLine({
  text,
  percent,
  onCancel,
  cancelLabel,
}: {
  text: string;
  percent: number | null;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground min-w-0 truncate" title={text}>
          {text}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {percent != null && <span className="text-muted-foreground tabular-nums">{percent}%</span>}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-muted-foreground/70 hover:text-destructive inline-flex items-center gap-1 rounded font-medium transition-colors"
            >
              <X className="size-3" />
              {cancelLabel}
            </button>
          )}
        </span>
      </div>
      <ProgressBar percent={percent} />
    </div>
  );
}

function ErrorLine({
  text,
  onRetry,
  retryLabel,
}: {
  text: string;
  onRetry: () => void;
  retryLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <AlertTriangle className="text-destructive size-3 shrink-0" />
      <span className="text-destructive min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-medium transition-colors"
      >
        {retryLabel}
      </button>
    </div>
  );
}

function humanBytes(n: number): string {
  if (!n || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
