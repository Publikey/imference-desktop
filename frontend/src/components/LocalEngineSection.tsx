import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw, Loader2, CheckCircle2, XCircle, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress";
import { api } from "@/lib/wails-bridge";
import type { EngineInfo, InstallPhase, InstallProgress, PythonInfo } from "@/lib/types";

// i18n keys per install phase, resolved at render.
const PHASE_KEY: Record<InstallPhase, string> = {
  detect: "engineSection.phaseDetect",
  venv: "engineSection.phaseVenv",
  torch: "engineSection.phaseTorch",
  "sidecar-deps": "engineSection.phaseSidecarDeps",
  engine: "engineSection.phaseEngine",
  extras: "engineSection.phaseExtras",
  model: "engineSection.phaseModel",
  done: "engineSection.phaseDone",
  error: "engineSection.phaseError",
  // Model-download-only phase; never reached by the engine installer, but the
  // Record must be exhaustive over InstallPhase.
  cancelled: "engineSection.phaseError",
};

const PHASE_ORDER: InstallPhase[] = [
  "detect",
  "venv",
  "torch",
  "sidecar-deps",
  "engine",
  "extras",
  "model",
];

type Props = {
  // Called after a successful install completes so the parent dialog can
  // refresh its `pythonPath` field (auto-filled by the Go side).
  onInstallDone: () => void;
};

export function LocalEngineSection({ onInstallDone }: Props) {
  const { t } = useTranslation();
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [pythonProbe, setPythonProbe] = useState<PythonInfo | null>(null);
  const [pythonError, setPythonError] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  // Local "is this thing running right now" flag — covers the gap between
  // clicking Install and the first progress event arriving.
  const [installing, setInstalling] = useState(false);

  // Refresh engine status + python probe on mount.
  useEffect(() => {
    void api.getEngineInfo().then(setEngineInfo);
    void api
      .detectPython()
      .then((p) => {
        setPythonProbe(p);
        setPythonError(null);
      })
      .catch((e) => {
        setPythonProbe(null);
        setPythonError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  // Subscribe to install progress for the lifetime of the section. Stays
  // subscribed even when not installing so we never miss a tail event.
  useEffect(() => {
    return api.onInstallProgress((p) => {
      setProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error") {
        setInstalling(false);
        // Re-fetch on a successful install — the venv now exists.
        if (p.phase === "done") {
          void api.getEngineInfo().then(setEngineInfo);
          onInstallDone();
        }
      } else {
        setInstalling(true);
      }
    });
  }, [onInstallDone]);

  const startInstall = async () => {
    setInstalling(true);
    setProgress({ phase: "detect", message: t("engineSection.startingMsg"), percentEstimate: 0, done: false });
    try {
      await api.installEngine();
    } catch (e) {
      setInstalling(false);
      setProgress({
        phase: "error",
        message: "",
        percentEstimate: 0,
        done: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const statusPill = renderStatusPill(engineInfo, installing, progress);

  return (
    <section className="bg-card rounded-2xl border p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t("engineSection.title")}</h3>
          {statusPill}
        </div>
        <div className="flex items-center gap-2">
          {engineInfo?.installed ? (
            <Button size="sm" variant="outline" onClick={startInstall} disabled={installing}>
              <RefreshCw className="size-3.5" />
              {t("common.reinstall")}
            </Button>
          ) : (
            <Button size="sm" onClick={startInstall} disabled={installing}>
              {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {t("common.install")}
            </Button>
          )}
        </div>
      </div>

      <PythonLine probe={pythonProbe} err={pythonError} />

      {engineInfo?.installed && !installing && (
        <>
          <p className="text-muted-foreground mt-2 text-xs">
            imference-engine{" "}
            <span className="font-mono">
              {engineInfo.engineVersion ? `v${engineInfo.engineVersion}` : t("engineSection.versionUnknown")}
            </span>
            {engineInfo.outdated && engineInfo.pinnedVersion && (
              <span className="text-yellow-700">
                {t("engineSection.updatingTo", { version: engineInfo.pinnedVersion })}
              </span>
            )}
          </p>
          <p className="text-muted-foreground mt-1 truncate font-mono text-xs" title={engineInfo.pythonPath}>
            venv: {engineInfo.pythonPath}
          </p>
        </>
      )}

      {installing && progress && <ProgressView p={progress} />}

      {progress?.error && !installing && (
        <p className="text-destructive mt-2 text-xs">{progress.error}</p>
      )}
    </section>
  );
}

function PythonLine({ probe, err }: { probe: PythonInfo | null; err: string | null }) {
  const { t } = useTranslation();
  if (err) {
    return (
      <p className="text-destructive text-xs">
        {t("engineSection.pythonNotFoundPrefix")}
        <a
          href="https://www.python.org/downloads/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          python.org/downloads
        </a>
        {t("engineSection.pythonNotFoundSuffix")}
      </p>
    );
  }
  if (!probe) {
    return <p className="text-muted-foreground text-xs">{t("engineSection.checkingPython")}</p>;
  }
  return (
    <p className="text-muted-foreground text-xs">
      {t("engineSection.pythonFoundPrefix", { version: probe.version })}
      <span className="font-mono">{probe.path}</span>
    </p>
  );
}

function ProgressView({ p }: { p: InstallProgress }) {
  const { t } = useTranslation();
  const currentIdx = PHASE_ORDER.indexOf(p.phase);
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {PHASE_KEY[p.phase] ? t(PHASE_KEY[p.phase]) : p.phase}
          {currentIdx >= 0 ? ` (${currentIdx + 1}/${PHASE_ORDER.length})` : ""}
        </span>
        {p.percentEstimate > 0 && <span className="tabular-nums">{p.percentEstimate}%</span>}
      </div>
      <ProgressBar percent={p.percentEstimate > 0 ? p.percentEstimate : null} />
      {p.message && (
        <p className="text-muted-foreground truncate font-mono text-[11px]" title={p.message}>
          {p.message}
        </p>
      )}
      <p className="text-muted-foreground/70 text-[11px]">
        {t("engineSection.pipHint")}
      </p>
    </div>
  );
}

function renderStatusPill(
  info: EngineInfo | null,
  installing: boolean,
  p: InstallProgress | null
) {
  if (installing) {
    return (
      <Badge color="yellow">
        <Loader2 className="size-3 animate-spin" /> <BadgeText k="engineSection.badgeInstalling" />
      </Badge>
    );
  }
  if (p?.phase === "error") {
    return (
      <Badge color="red">
        <XCircle className="size-3" /> <BadgeText k="engineSection.badgeError" />
      </Badge>
    );
  }
  if (info?.installed) {
    return (
      <Badge color="green">
        <CheckCircle2 className="size-3" /> <BadgeText k="engineSection.badgeInstalled" />
      </Badge>
    );
  }
  return (
    <Badge color="gray">
      <Circle className="size-3" /> <BadgeText k="engineSection.badgeNotInstalled" />
    </Badge>
  );
}

// Tiny helper so renderStatusPill (a plain function, no hooks) stays usable.
function BadgeText({ k }: { k: string }) {
  const { t } = useTranslation();
  return <>{t(k)}</>;
}

function Badge({
  color,
  children,
}: {
  color: "green" | "yellow" | "red" | "gray";
  children: React.ReactNode;
}) {
  const cls = {
    green: "bg-green-500/15 text-green-700",
    yellow: "bg-yellow-500/15 text-yellow-700",
    red: "bg-destructive/15 text-destructive",
    gray: "bg-muted text-muted-foreground",
  }[color];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {children}
    </span>
  );
}
