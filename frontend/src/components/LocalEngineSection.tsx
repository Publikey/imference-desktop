import { useEffect, useState } from "react";
import { Download, RefreshCw, Loader2, CheckCircle2, XCircle, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/wails-bridge";
import type { EngineInfo, InstallPhase, InstallProgress, PythonInfo } from "@/lib/types";

const PHASE_LABEL: Record<InstallPhase, string> = {
  detect: "Detecting Python",
  venv: "Creating venv",
  torch: "Downloading torch",
  "sidecar-deps": "Installing sidecar deps",
  engine: "Downloading imference-engine",
  extras: "Installing sd-embed (weighted prompts)",
  model: "Downloading SDXL weights (~6.9 GB)",
  done: "Done",
  error: "Error",
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
    setProgress({ phase: "detect", message: "Starting…", percentEstimate: 0, done: false });
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
    <section className="border-border rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Local engine</h3>
          {statusPill}
        </div>
        <div className="flex items-center gap-2">
          {engineInfo?.installed ? (
            <Button size="sm" variant="outline" onClick={startInstall} disabled={installing}>
              <RefreshCw className="size-3.5" />
              Reinstall
            </Button>
          ) : (
            <Button size="sm" onClick={startInstall} disabled={installing}>
              {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Install
            </Button>
          )}
        </div>
      </div>

      <PythonLine probe={pythonProbe} err={pythonError} />

      {engineInfo?.installed && !installing && (
        <p className="text-muted-foreground mt-2 truncate font-mono text-xs" title={engineInfo.pythonPath}>
          venv: {engineInfo.pythonPath}
        </p>
      )}

      {installing && progress && <ProgressView p={progress} />}

      {progress?.error && !installing && (
        <p className="text-destructive mt-2 text-xs">{progress.error}</p>
      )}
    </section>
  );
}

function PythonLine({ probe, err }: { probe: PythonInfo | null; err: string | null }) {
  if (err) {
    return (
      <p className="text-destructive text-xs">
        Python not found. Install Python 3.10+ from{" "}
        <a
          href="https://www.python.org/downloads/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          python.org/downloads
        </a>
        .
      </p>
    );
  }
  if (!probe) {
    return <p className="text-muted-foreground text-xs">Checking for Python…</p>;
  }
  return (
    <p className="text-muted-foreground text-xs">
      Python {probe.version} found at{" "}
      <span className="font-mono">{probe.path}</span>
    </p>
  );
}

function ProgressView({ p }: { p: InstallProgress }) {
  const currentIdx = PHASE_ORDER.indexOf(p.phase);
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {PHASE_LABEL[p.phase] ?? p.phase}
          {currentIdx >= 0 ? ` (${currentIdx + 1}/${PHASE_ORDER.length})` : ""}
        </span>
        {p.percentEstimate > 0 && <span className="tabular-nums">{p.percentEstimate}%</span>}
      </div>
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded">
        <div
          className={
            "h-full transition-all " +
            (p.percentEstimate > 0
              ? "bg-primary"
              : "animate-pulse bg-primary/50 w-full")
          }
          style={p.percentEstimate > 0 ? { width: `${p.percentEstimate}%` } : undefined}
        />
      </div>
      {p.message && (
        <p className="text-muted-foreground truncate font-mono text-[11px]" title={p.message}>
          {p.message}
        </p>
      )}
      <p className="text-muted-foreground/70 text-[11px]">
        Detailed pip output streams to the Logs panel (open it from the header).
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
        <Loader2 className="size-3 animate-spin" /> installing
      </Badge>
    );
  }
  if (p?.phase === "error") {
    return (
      <Badge color="red">
        <XCircle className="size-3" /> error
      </Badge>
    );
  }
  if (info?.installed) {
    return (
      <Badge color="green">
        <CheckCircle2 className="size-3" /> installed
      </Badge>
    );
  }
  return (
    <Badge color="gray">
      <Circle className="size-3" /> not installed
    </Badge>
  );
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
