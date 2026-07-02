import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Settings,
  Cloud,
  Cpu,
  Loader2,
  ScrollText,
  Sparkles,
  ImageIcon,
  AlertCircle,
  CornerDownLeft,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ModelBar } from "@/components/ModelBar";
import { LogPanel } from "@/components/LogPanel";
import { api } from "@/lib/wails-bridge";
import { installLogCapture } from "@/lib/log-capture";
import { cn } from "@/lib/utils";
import type {
  AppSettings,
  GenerateProgress,
  GenerationResult,
  LogEntry,
  ModelInfo,
  SidecarStatus,
} from "@/lib/types";

// Module-load side effect: install console + window error hooks before any
// component renders. The api wrapping itself happens inside wails-bridge.ts
// so SettingsDialog and any future component that imports `api` get the
// logged version automatically.
installLogCapture();

// POC defaults are dialed down for fast dev iteration — quality drops at
// 512x512 (SDXL is trained at 1024) and below ~20 steps, but a 10-15s
// generation beats a 1-2 min one when you're just verifying the pipeline.
const DEFAULT_PARAMS = {
  width: 512,
  height: 512,
  numSteps: 12,
  guidanceScale: 6.0,
};

type Mode = "local" | "cloud";

// modelParams derives generation params from the selected model's config (used
// for both local and cloud — each mode passes its own selected model). When a
// model is chosen we honor its steps/cfg defaults and a resolution matching its
// format_code (SDXL is trained at 1024). Falls back to the fast dev defaults
// when no model is selected. The model's prompt prefix, negative prompt,
// scheduler and clip-skip are injected server-side (local: App.GenerateLocal;
// cloud: the imference server already knows the model's config).
function modelParams(model: ModelInfo | null | undefined) {
  if (!model) return DEFAULT_PARAMS;
  const dims =
    model.formatCode === "portrait"
      ? { width: 832, height: 1216 }
      : model.formatCode === "landscape"
        ? { width: 1216, height: 832 }
        : { width: 1024, height: 1024 }; // square / unknown
  return {
    ...dims,
    numSteps: model.stepsDefault || 28,
    guidanceScale: model.cfgDefault || 6.0,
  };
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: "idle" });
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("local");
  const [running, setRunning] = useState<Mode | null>(null);
  const [image, setImage] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [errorLogCount, setErrorLogCount] = useState(0);
  // img2img: optional source image (data-URL) + denoising strength. Local-only —
  // the cloud path ignores them. null source → plain text2img.
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [strength, setStrength] = useState(0.6);
  // Clean "not installed" state instead of a scary "Local error". Assume true
  // initially to avoid a flash before the first probe resolves.
  const [engineInstalled, setEngineInstalled] = useState(true);
  // Per-step inference progress (local only), from the "generate:progress" event.
  const [progress, setProgress] = useState<GenerateProgress | null>(null);

  useEffect(() => api.onGenerateProgress(setProgress), []);

  const handleSettingsSaved = useCallback((next: AppSettings) => {
    setSettings(next);
  }, []);

  useEffect(() => {
    void api.getSettings().then(setSettings);
    void api.getSidecarStatus().then(setSidecar);
    void api.getEngineInfo().then((i) => setEngineInstalled(i.installed)).catch(() => {});
    return api.onSidecarStatus(setSidecar);
  }, []);

  // Re-check install state on every sidecar transition (e.g. after install).
  useEffect(() => {
    void api.getEngineInfo().then((i) => setEngineInstalled(i.installed)).catch(() => {});
  }, [sidecar.state]);

  // Header badge: tally of error-level entries since last panel open.
  useEffect(() => {
    void api.getLogs().then((seed: LogEntry[]) => {
      setErrorLogCount(seed.filter((e) => e.level === "error").length);
    });
    return api.onLogEntry((e) => {
      if (e.level === "error") setErrorLogCount((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    if (logsOpen) setErrorLogCount(0);
  }, [logsOpen]);

  const cloudReady = !!settings?.apiKey && !!settings?.cloudModel;
  const localReady = sidecar.state === "ready";

  // Nudge the default mode toward whatever is actually usable on first load —
  // if local isn't ready but cloud is, start there. Only runs while idle so it
  // never fights a user's explicit pick mid-session.
  useEffect(() => {
    if (running) return;
    if (!localReady && cloudReady) setMode("cloud");
  }, [localReady, cloudReady, running]);

  const modeReady = mode === "cloud" ? cloudReady : localReady;
  const canGenerate = modeReady && !!prompt.trim() && running === null;

  const run = useCallback(
    async (which: Mode) => {
      if (!prompt.trim() || running) return;
      setRunning(which);
      setError(null);
      setProgress(null);
      try {
        const result =
          which === "cloud"
            ? await api.generateCloud({
                prompt: prompt.trim(),
                ...modelParams(settings?.cloudModelInfo),
              })
            : await api.generateLocal({
                prompt: prompt.trim(),
                ...modelParams(settings?.localModel),
                ...(sourceImage ? { sourceImage, strength } : {}),
              });
        setImage(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(null);
      }
    },
    [prompt, running, settings?.localModel, settings?.cloudModelInfo, sourceImage, strength]
  );

  const generate = () => {
    if (!canGenerate) return;
    void run(mode);
  };

  // Hint shown under the composer: what this generation will use.
  const contextHint = useMemo(() => {
    if (mode === "cloud") {
      if (!settings?.apiKey) return "Cloud not configured — add an API key in Settings";
      const c = settings?.cloudModelInfo;
      return c ? `${c.name} · ${c.stepsDefault} steps` : "Pick a cloud model above";
    }
    if (!engineInstalled) return "Local engine not installed — open Settings";
    if (!localReady) {
      return sidecar.state === "error"
        ? "Local engine error — see Logs"
        : sidecar.state === "starting"
          ? "Local engine starting…"
          : "Local engine not ready — pick a model above";
    }
    const m = settings?.localModel;
    return m ? `${m.name} · ${m.stepsDefault} steps` : "Pick a model above";
  }, [mode, localReady, sidecar.state, settings?.apiKey, settings?.cloudModelInfo, settings?.localModel, engineInstalled]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob aurora-blob-1" />
        <span className="aurora-blob aurora-blob-2" />
        <span className="aurora-blob aurora-blob-3" />
      </div>
      <Header
        sidecar={sidecar}
        engineInstalled={engineInstalled}
        errorLogCount={errorLogCount}
        onToggleLogs={() => setLogsOpen((o) => !o)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 pt-10 pb-16">
          <div className="space-y-2 pt-2 text-center">
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight">
              What will you <span className="brand-text">imagine</span>?
            </h2>
            <p className="text-muted-foreground text-sm">
              Describe an image and generate it locally or in the cloud.
            </p>
          </div>

          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

          <ModelBar
            mode={mode}
            settings={settings}
            onModelSwitched={handleSettingsSaved}
          />

          <Composer
            prompt={prompt}
            onPromptChange={setPrompt}
            mode={mode}
            onModeChange={setMode}
            localReady={localReady}
            cloudReady={cloudReady}
            running={running}
            canGenerate={canGenerate}
            contextHint={contextHint}
            onGenerate={generate}
            sourceImage={sourceImage}
            onSourceImageChange={setSourceImage}
            strength={strength}
            onStrengthChange={setStrength}
          />

          <ResultCanvas image={image} running={running} progress={progress} />
        </div>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={handleSettingsSaved}
      />
      <LogPanel open={logsOpen} onOpenChange={setLogsOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — frosted, sticky, content-deferential.
// ---------------------------------------------------------------------------

function Header({
  sidecar,
  engineInstalled,
  errorLogCount,
  onToggleLogs,
  onOpenSettings,
}: {
  sidecar: SidecarStatus;
  engineInstalled: boolean;
  errorLogCount: number;
  onToggleLogs: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="bg-background/70 supports-[backdrop-filter]:bg-background/55 sticky top-0 z-10 flex items-center justify-between border-b px-5 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-2.5">
        <div className="brand-surface flex size-7 items-center justify-center rounded-[9px] text-white shadow-[0_3px_10px_-2px_color-mix(in_oklch,var(--brand-to)_55%,transparent)]">
          <Sparkles className="size-4" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold tracking-tight">Imference</span>
          <StatusDot status={sidecar} engineInstalled={engineInstalled} />
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleLogs}
          aria-label={errorLogCount > 0 ? `Logs, ${errorLogCount} errors` : "Logs"}
          className="text-muted-foreground hover:text-foreground gap-1.5"
        >
          <ScrollText className="size-4" />
          Logs
          {errorLogCount > 0 && (
            <span className="bg-destructive/10 text-destructive ml-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums">
              {errorLogCount > 99 ? "99+" : errorLogCount}
            </span>
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          aria-label="Settings"
          className="text-muted-foreground hover:text-foreground"
        >
          <Settings className="size-[18px]" />
        </Button>
      </div>
    </header>
  );
}

function StatusDot({ status, engineInstalled }: { status: SidecarStatus; engineInstalled: boolean }) {
  // "Not installed" is a setup state, not an error — show it neutrally and ahead
  // of idle/error (the sidecar just isn't running yet).
  const { dot, label, title } =
    status.state === "ready"
      ? { dot: "bg-emerald-500", label: `Local ready · ${status.device}`, title: undefined }
      : status.state === "starting"
        ? { dot: "bg-amber-500 animate-pulse", label: "Local starting", title: undefined }
        : !engineInstalled
          ? { dot: "bg-muted-foreground/40", label: "Engine not installed", title: "Install the local engine in Settings" }
          : status.state === "error"
            ? { dot: "bg-destructive", label: "Local error", title: status.message }
            : { dot: "bg-muted-foreground/40", label: "Local idle", title: undefined };

  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
      title={title}
    >
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer — the single focal input. Prompt + mode switch + primary action,
// grouped in one elevated region (Law of Common Region / Proximity).
// ---------------------------------------------------------------------------

function Composer({
  prompt,
  onPromptChange,
  mode,
  onModeChange,
  localReady,
  cloudReady,
  running,
  canGenerate,
  contextHint,
  onGenerate,
  sourceImage,
  onSourceImageChange,
  strength,
  onStrengthChange,
}: {
  prompt: string;
  onPromptChange: (v: string) => void;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  localReady: boolean;
  cloudReady: boolean;
  running: Mode | null;
  canGenerate: boolean;
  contextHint: string;
  onGenerate: () => void;
  sourceImage: string | null;
  onSourceImageChange: (v: string | null) => void;
  strength: number;
  onStrengthChange: (v: number) => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onGenerate();
    }
  };

  return (
    <div className="composer bg-card rounded-[26px] border">
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="A serene mountain lake at golden hour, photorealistic…"
        rows={3}
        className="placeholder:text-muted-foreground/70 block max-h-60 min-h-24 w-full resize-none rounded-t-[26px] border-0 bg-transparent px-5 pt-4 pb-2 text-[15px] leading-relaxed outline-none"
      />
      {mode === "local" && (
        <Img2ImgBar
          sourceImage={sourceImage}
          onSourceImageChange={onSourceImageChange}
          strength={strength}
          onStrengthChange={onStrengthChange}
        />
      )}
      <div className="flex items-center justify-between gap-3 px-3 pt-1 pb-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <ModeSwitch
            mode={mode}
            onModeChange={onModeChange}
            localReady={localReady}
            cloudReady={cloudReady}
          />
          <span className="text-muted-foreground/80 truncate pl-1 text-[11px]" title={contextHint}>
            {contextHint}
          </span>
        </div>

        <Button
          size="lg"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="btn-brand h-11 rounded-full px-6 text-[15px] font-semibold disabled:opacity-40 disabled:saturate-0"
        >
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {running ? "Generating…" : "Generate"}
          {!running && (
            <kbd className="ml-1 hidden items-center gap-0.5 rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex">
              <CornerDownLeft className="size-2.5" />
            </kbd>
          )}
        </Button>
      </div>
    </div>
  );
}

// img2img attachment row inside the composer (local mode only). Collapsed to a
// single "add source image" affordance until an image is picked; then shows a
// thumbnail + denoising-strength slider + remove.
function Img2ImgBar({
  sourceImage,
  onSourceImageChange,
  strength,
  onStrengthChange,
}: {
  sourceImage: string | null;
  onSourceImageChange: (v: string | null) => void;
  strength: number;
  onStrengthChange: (v: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      onSourceImageChange(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
    e.target.value = ""; // let the user re-pick the same file later
  };

  return (
    <div className="border-border/60 mx-3 mt-1 border-t pt-2">
      <input ref={inputRef} type="file" accept="image/*" onChange={onPick} className="hidden" />
      {sourceImage ? (
        <div className="flex items-center gap-3">
          <img
            src={sourceImage}
            alt="img2img source"
            className="size-11 shrink-0 rounded-lg border object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-[11px]">
                Image-to-image · strength {strength.toFixed(2)}
              </span>
              <button
                type="button"
                onClick={() => onSourceImageChange(null)}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
              >
                <X className="size-3" /> Remove
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={strength}
              onChange={(e) => onStrengthChange(Number(e.target.value))}
              className="h-1 w-full cursor-pointer accent-[var(--brand-to)]"
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[11px]"
        >
          <ImageIcon className="size-3.5" /> Add source image (img2img)
        </button>
      )}
    </div>
  );
}

function ModeSwitch({
  mode,
  onModeChange,
  localReady,
  cloudReady,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  localReady: boolean;
  cloudReady: boolean;
}) {
  return (
    <div className="bg-muted inline-flex items-center gap-0.5 rounded-full p-0.5 text-xs">
      <SegBtn
        active={mode === "local"}
        ready={localReady}
        onClick={() => onModeChange("local")}
        icon={<Cpu className="size-3.5" />}
        label="Local"
      />
      <SegBtn
        active={mode === "cloud"}
        ready={cloudReady}
        onClick={() => onModeChange("cloud")}
        icon={<Cloud className="size-3.5" />}
        label="Cloud"
      />
    </div>
  );
}

function SegBtn({
  active,
  ready,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  ready: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-all",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {label}
      <span
        className={cn(
          "size-1.5 rounded-full",
          ready ? "bg-emerald-500" : "bg-muted-foreground/30"
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Result canvas — the hero. Empty / loading / result, each composed to avoid
// layout shift (Doherty) and to make the reveal feel intentional (Peak-End).
// ---------------------------------------------------------------------------

function ResultCanvas({
  image,
  running,
  progress,
}: {
  image: GenerationResult | null;
  running: Mode | null;
  progress: GenerateProgress | null;
}) {
  if (running) {
    const pct = progress && progress.total > 0 ? progress.percent : null;
    const label =
      progress && progress.total > 0
        ? `Generating… step ${progress.step}/${progress.total}`
        : "Generating…";
    return (
      <div className="bg-muted/40 relative aspect-square w-full overflow-hidden rounded-[26px] border">
        <div className="via-foreground/[0.04] absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent to-transparent" />
        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm">{label}</span>
          {pct !== null && (
            <>
              <div className="bg-muted mt-1 h-1.5 w-44 max-w-full overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full transition-[width] duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums">{pct}%</span>
            </>
          )}
        </div>
        <style>{`@keyframes shimmer{100%{transform:translateX(100%)}}`}</style>
      </div>
    );
  }

  if (!image) {
    return (
      <div className="border-border/60 text-muted-foreground/70 relative flex aspect-square w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-[26px] border border-dashed">
        <div className="canvas-glow pointer-events-none absolute inset-0" />
        <div className="brand-surface relative flex size-14 items-center justify-center rounded-2xl text-white shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--brand-to)_60%,transparent)]">
          <ImageIcon className="size-6" strokeWidth={1.75} />
        </div>
        <p className="relative text-sm">Your image will appear here</p>
      </div>
    );
  }

  return (
    <figure className="animate-in fade-in zoom-in-95 flex flex-col gap-3 duration-500">
      <img
        src={image.imageBase64}
        alt="Generated"
        className="ring-border/60 w-full rounded-[26px] shadow-[0_18px_50px_-16px_rgba(0,0,0,0.3)] ring-1"
      />
      <figcaption className="flex items-center justify-between gap-3 px-1 text-xs">
        <span className="text-muted-foreground inline-flex items-center gap-2">
          <span className="bg-muted rounded-full px-2 py-0.5 font-medium capitalize">
            {image.source}
          </span>
          <span className="tabular-nums">seed {image.seed}</span>
        </span>
        {image.savedPath ? (
          <span
            className="text-muted-foreground/70 max-w-[60%] truncate font-mono"
            title={image.savedPath}
          >
            {image.savedPath}
          </span>
        ) : (
          <span className="text-amber-600">not saved to disk</span>
        )}
      </figcaption>
    </figure>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="border-destructive/25 bg-destructive/5 text-destructive animate-in fade-in slide-in-from-top-1 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1 leading-relaxed">{message}</p>
      <button
        onClick={onDismiss}
        className="hover:text-destructive/70 shrink-0 text-xs font-medium"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
