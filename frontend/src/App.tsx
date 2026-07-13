import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Trash2,
  ChevronDown,
  RotateCcw,
  SlidersHorizontal,
  Download,
  Play,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CustomModelDialog } from "@/components/CustomModelDialog";
import { ModelBar } from "@/components/ModelBar";
import { PaymentBar } from "@/components/PaymentBar";
import { LogPanel } from "@/components/LogPanel";
import { api } from "@/lib/wails-bridge";
import logoUrl from "./assets/logo.svg";
import { installLogCapture } from "@/lib/log-capture";
import { cn } from "@/lib/utils";
import type {
  AppSettings,
  GalleryFacets,
  GalleryFilter,
  GenerateProgress,
  GenerationMeta,
  FormatOption,
  GenerationRequest,
  GenerationResult,
  InstallProgress,
  LogEntry,
  ModelInfo,
  PaymentMode,
  SavedImage,
  SidecarStatus,
  UpdateInfo,
} from "@/lib/types";
import { Browser } from "@wailsio/runtime";

// Module-load side effect: install console + window error hooks before any
// component renders. The api wrapping itself happens inside wails-bridge.ts
// so SettingsDialog and any future component that imports `api` get the
// logged version automatically.
installLogCapture();

type Mode = "local" | "cloud";

// The composer's primary button: generate, or download the pending local model.
type ComposerAction = {
  label: string;
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  kind: "generate" | "download";
};

// A single generation, tracked independently so several can run at once and
// completed ones stay visible in the grid (newest first).
type Job = {
  id: string;
  mode: Mode;
  prompt: string;
  status: "running" | "done" | "error";
  image?: GenerationResult;
  error?: string;
  progress?: GenerateProgress | null; // per-step (local only)
};

let jobSeq = 0;
const nextJobId = () => `job-${Date.now()}-${jobSeq++}`;

// User-tweakable generation parameters, seeded from the selected model's catalog
// defaults and reset when the model changes.
type GenParams = {
  prePrompt: string; // quality-tag prefix, prepended to the user prompt (client-side)
  formatCode: string; // "square" | "portrait" | "landscape"
  steps: number;
  cfg: number;
  negativePrompt: string;
  seedMode: "random" | "fixed";
  seed: number;
  clipSkip: number | null; // local only
  scheduler: string; // local only
};

// Generic formats used only when the catalog (im_format) carries none.
const FALLBACK_FORMATS: FormatOption[] = [
  { formatCode: "square", name: "Square", width: 1024, height: 1024, ratio: "1:1", isDefault: true },
  { formatCode: "portrait", name: "Portrait", width: 832, height: 1216, ratio: "2:3", isDefault: false },
  { formatCode: "landscape", name: "Landscape", width: 1216, height: 832, ratio: "3:2", isDefault: false },
];

// A model's supported formats come from im_format; fall back to generic ones.
function formatOptions(model: ModelInfo | null | undefined): FormatOption[] {
  return model?.formats && model.formats.length > 0 ? model.formats : FALLBACK_FORMATS;
}

function defaultFormatCode(model: ModelInfo): string {
  const opts = formatOptions(model);
  return (opts.find((o) => o.isDefault) ?? opts[0])?.formatCode ?? "square";
}

// Resolve a format code to its real per-model dimensions (im_format).
function dimsForModel(
  model: ModelInfo | null | undefined,
  formatCode: string
): { width: number; height: number } {
  const opts = formatOptions(model);
  const f = opts.find((o) => o.formatCode === formatCode) ?? opts.find((o) => o.isDefault) ?? opts[0];
  return f ? { width: f.width, height: f.height } : { width: 1024, height: 1024 };
}

// defaultParams seeds the tweakable params from a model's catalog config.
function defaultParams(model: ModelInfo): GenParams {
  return {
    prePrompt: model.promptPre || "",
    formatCode: defaultFormatCode(model),
    steps: model.stepsDefault || 28,
    cfg: model.cfgDefault || 6,
    negativePrompt: model.promptNegative || "",
    seedMode: "random",
    seed: 0,
    clipSkip: model.skipDefault > 0 ? model.skipDefault : null,
    scheduler: model.schedulerDefault || "",
  };
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: "idle" });
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("local");
  // All generations, newest first. Running ones show a live placeholder; done
  // ones stay as images in the grid.
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // When set, the Settings dialog scrolls to this section on open (deep-links
  // from the payment bar: "apikey" / "x402").
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [logsOpen, setLogsOpen] = useState(false);
  const [errorLogCount, setErrorLogCount] = useState(0);
  // img2img: optional source image (data-URL) + denoising strength. Local-only —
  // the cloud path ignores them. null source → plain text2img.
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [strength, setStrength] = useState(0.6);
  // Clean "not installed" state instead of a scary "Local error". Assume true
  // initially to avoid a flash before the first probe resolves.
  const [engineInstalled, setEngineInstalled] = useState(true);
  const [installing, setInstalling] = useState(false);
  // Tweakable generation params, seeded from the active model's defaults.
  const [params, setParams] = useState<GenParams | null>(null);
  // Local model selection is decoupled from its (heavy) download: picking a model
  // in the bar sets it pending; the primary button downloads it on demand, and
  // becomes "Generate" once the weights are on disk and the engine is ready.
  const [pendingLocalModel, setPendingLocalModel] = useState<ModelInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState<InstallProgress | null>(null);
  // Whether a usable x402 wallet exists (keychain — the real source of truth,
  // not settings.walletAddress). Drives cloud gating in x402 mode.
  const [walletConfigured, setWalletConfigured] = useState(false);

  // Per-step progress is a single global stream (the sidecar runs local jobs
  // serially), so attribute each tick to the oldest still-running local job —
  // the one the sidecar is currently denoising.
  useEffect(
    () =>
      api.onGenerateProgress((p) => {
        setJobs((js) => {
          let target = -1;
          for (let i = js.length - 1; i >= 0; i--) {
            if (js[i].status === "running" && js[i].mode === "local") {
              target = i;
              break;
            }
          }
          if (target === -1) return js;
          const next = js.slice();
          next[target] = { ...next[target], progress: p };
          return next;
        });
      }),
    []
  );

  const handleSettingsSaved = useCallback((next: AppSettings) => {
    setSettings(next);
  }, []);

  // Open Settings, optionally scrolled to a section (payment-bar deep-links).
  const openSettings = useCallback((section?: string) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  // --- Custom user checkpoints (.safetensors referenced in place) ---------
  // Two-step add flow: native picker first, then a small dialog to pick the
  // engine backend. customModelPath non-null = dialog open.
  const [customModelPath, setCustomModelPath] = useState<string | null>(null);

  const addCustomModel = useCallback(async () => {
    try {
      const path = await api.pickModelFile();
      if (path) setCustomModelPath(path);
    } catch {
      // picker failure = treat as cancel
    }
  }, []);

  const confirmCustomModel = useCallback(
    async (path: string, backend: string, baseModel: string) => {
      const next = await api.useCustomModel(path, backend, baseModel);
      setSettings(next);
      setPendingLocalModel(next.localModel ?? null);
    },
    []
  );

  const selectCustomModel = useCallback(async (m: ModelInfo) => {
    if (!m.localPath) return;
    const next = await api.useCustomModel(m.localPath, m.backendType ?? "sdxl", m.baseModel ?? "");
    setSettings(next);
    setPendingLocalModel(next.localModel ?? null);
  }, []);

  const removeCustomModel = useCallback(async (m: ModelInfo) => {
    if (!m.localPath) return;
    try {
      const next = await api.removeCustomModel(m.localPath);
      setSettings(next);
      setPendingLocalModel((p) => (p?.modelCode === m.modelCode ? (next.localModel ?? null) : p));
    } catch {
      // removal failure is non-fatal; the row stays
    }
  }, []);

  // Switch the cloud payment method (persisted; cloud generation reads it).
  const setPaymentMode = useCallback(
    (m: PaymentMode) => {
      if (!settings) return;
      const next = { ...settings, paymentMode: m };
      setSettings(next); // optimistic
      void api.saveSettings(next).then(setSettings).catch(() => {});
    },
    [settings]
  );

  useEffect(() => {
    void api.getSettings().then(setSettings);
    void api.getSidecarStatus().then(setSidecar);
    void api.getEngineInfo().then((i) => setEngineInstalled(i.installed)).catch(() => {});
    return api.onSidecarStatus(setSidecar);
  }, []);

  // One-shot update check at startup. "dev" builds report no update without a
  // network call; any failure is silent (no banner) — never blocks the app.
  // Dismiss only hides the banner for this session: it returns on every launch
  // on purpose, to keep nudging until the user updates (frequent breaking
  // changes are expected in the coming releases).
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    void api.checkForUpdate().then(setUpdateInfo).catch(() => {});
  }, []);
  const dismissUpdate = useCallback(() => setUpdateInfo(null), []);

  // App's own version — shown under the logo in the header.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void api.getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Re-check install state on every sidecar transition (e.g. after install).
  useEffect(() => {
    void api.getEngineInfo().then((i) => setEngineInstalled(i.installed)).catch(() => {});
  }, [sidecar.state]);

  // Track the (long) engine install, and refresh the installed flag when done.
  useEffect(
    () =>
      api.onInstallProgress((p) => {
        if (p.phase === "done" || p.phase === "error") {
          setInstalling(false);
          void api.getEngineInfo().then((i) => setEngineInstalled(i.installed)).catch(() => {});
        } else {
          setInstalling(true);
        }
      }),
    []
  );

  // Home-screen engine control: install / start / stop the local engine on demand.
  const installEngine = useCallback(() => {
    setInstalling(true);
    void api.installEngine().catch(() => setInstalling(false));
  }, []);
  const startEngine = useCallback(() => {
    void api.startSidecar().catch(() => {});
  }, []);
  const stopEngine = useCallback(() => {
    void api.stopSidecar().catch(() => {});
  }, []);

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

  // Cloud is ready when a model is picked AND the active payment method is
  // configured (x402 → wallet present; bearer → API key present). Funding is
  // surfaced by the PaymentBar; the server rejects an under-funded request.
  // x402 is gated on the ACTUAL wallet (keychain), not settings.walletAddress —
  // that mirror is only written on generate/import, so a fresh settings.json with
  // an existing keychain wallet would otherwise read as "not configured".
  const cloudConfigured =
    settings?.paymentMode === "x402" ? walletConfigured : !!settings?.apiKey;
  const cloudReady = cloudConfigured && !!settings?.cloudModel;

  // Refresh wallet-configured state whenever x402 is (or becomes) the mode, or a
  // wallet is generated/imported (walletAddress changes). Reads the keychain.
  useEffect(() => {
    if (settings?.paymentMode !== "x402") return;
    void api.getWalletInfo().then((w) => setWalletConfigured(w.configured)).catch(() => {});
  }, [settings?.paymentMode, settings?.walletAddress]);

  // Seed the pending local selection from the persisted (downloaded) model, and
  // keep it in sync when a download completes (settings.localModel updates).
  useEffect(() => {
    if (settings?.localModel) setPendingLocalModel((cur) => cur ?? settings.localModel!);
  }, [settings?.localModel]);

  // Local download orchestration lives here (App owns the primary button). One
  // subscription for the whole app lifetime.
  useEffect(() => {
    return api.onModelProgress((p) => {
      setDlProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error") {
        setDownloading(false);
        if (p.phase === "done") {
          void api.getSettings().then((s) => {
            setSettings(s);
            if (s.localModel) setPendingLocalModel(s.localModel);
          });
        }
      } else {
        setDownloading(true);
      }
    });
  }, []);

  const downloadLocalModel = useCallback(() => {
    if (!pendingLocalModel || downloading) return;
    setDownloading(true);
    setDlProgress({
      phase: "model",
      message: `Preparing ${pendingLocalModel.name}`,
      percentEstimate: 0,
      done: false,
    });
    void api.selectLocalModel(pendingLocalModel.modelCode).catch((e) => {
      setDownloading(false);
      setDlProgress({
        phase: "error",
        message: "",
        percentEstimate: 0,
        done: true,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }, [pendingLocalModel, downloading]);

  // The selected local model is "downloaded" when it matches the persisted one.
  const localDownloaded =
    !!pendingLocalModel && settings?.localModel?.modelCode === pendingLocalModel.modelCode;
  const localReady = sidecar.state === "ready" && localDownloaded;
  const localNeedsDownload = !!pendingLocalModel && !localDownloaded;

  // The model whose params drive the current mode's generation (pending local
  // pick even before its weights are downloaded, so params preview correctly).
  const activeModel =
    (mode === "cloud" ? settings?.cloudModelInfo : pendingLocalModel) ?? null;

  // Reset the tweakable params to the model's defaults whenever the active model
  // (or mode) changes. Re-selecting the same model keeps the user's tweaks.
  useEffect(() => {
    setParams(activeModel ? defaultParams(activeModel) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeModel?.modelCode]);

  // Nudge the default mode toward whatever is usable on first load — if local
  // isn't ready but cloud is, start there. Strictly ONE-SHOT, decided when the
  // persisted settings first arrive: re-running on every localReady change made
  // any local-model selection (pending pick / sidecar restart drops localReady)
  // yank the user back to cloud mid-session.
  const modeNudged = useRef(false);
  useEffect(() => {
    if (modeNudged.current || !settings) return;
    modeNudged.current = true;
    if (!localReady && cloudReady) setMode("cloud");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Multiple generations may run at once — the button isn't gated on a running job.
  const canGenerate = (mode === "cloud" ? cloudReady : localReady) && !!prompt.trim();

  const run = useCallback(
    (which: Mode) => {
      const p = prompt.trim();
      if (!p) return;
      const model = which === "cloud" ? settings?.cloudModelInfo : settings?.localModel;
      const pr = params ?? (model ? defaultParams(model) : null);
      // Compose the pre-prompt (quality tags) client-side — the server prepends
      // nothing, and it matters a lot for SDXL quality. The catalog's prompt_pre
      // already ends with a separator.
      const full = (pr?.prePrompt ?? "") + p;
      const id = nextJobId();
      setJobs((js) => [{ id, mode: which, prompt: full, status: "running", progress: null }, ...js]);

      const req: GenerationRequest = {
        prompt: full,
        ...dimsForModel(model, pr?.formatCode ?? ""),
        numSteps: pr?.steps ?? model?.stepsDefault ?? 28,
        guidanceScale: pr?.cfg ?? model?.cfgDefault ?? 6,
      };
      if (pr?.negativePrompt) req.negativePrompt = pr.negativePrompt;
      if (pr && pr.seedMode === "fixed") req.seed = pr.seed;
      if (which === "local") {
        // clip-skip / scheduler are only honored by the local sidecar (the cloud
        // API uses the model's server-side defaults).
        if (pr?.clipSkip != null) req.clipSkip = pr.clipSkip;
        if (pr?.scheduler) req.scheduler = pr.scheduler;
        if (sourceImage) {
          req.sourceImage = sourceImage;
          req.strength = strength;
        }
      }

      const call = which === "cloud" ? api.generateCloud(req) : api.generateLocal(req);
      call
        .then((result) =>
          setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "done", image: result } : j)))
        )
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "error", error: msg } : j)));
        });
    },
    [prompt, settings?.localModel, settings?.cloudModelInfo, params, sourceImage, strength]
  );

  // Primary button: in local mode, download the pending model first (dedicated
  // action — no auto-download on select); otherwise generate. Cmd/Ctrl+Enter
  // triggers whichever is current.
  const primary: ComposerAction = useMemo(() => {
    if (mode === "local" && downloading)
      return { label: "Downloading…", onClick: () => {}, disabled: true, busy: true, kind: "download" };
    if (mode === "local" && localNeedsDownload)
      return {
        label: "Download model",
        onClick: downloadLocalModel,
        disabled: !pendingLocalModel,
        busy: false,
        kind: "download",
      };
    return {
      label: "Generate",
      onClick: () => {
        if (canGenerate) run(mode);
      },
      disabled: !canGenerate,
      busy: false,
      kind: "generate",
    };
  }, [mode, downloading, localNeedsDownload, pendingLocalModel, downloadLocalModel, canGenerate, run]);

  // Hint shown under the composer: what this generation will use (params live in
  // the Parameters panel now, so no steps/cfg duplication here).
  const contextHint = useMemo(() => {
    if (mode === "cloud") {
      if (!cloudConfigured) return "Configure a payment method above";
      const c = settings?.cloudModelInfo;
      if (!c) return "Pick a cloud model above";
      return c.cost > 0 ? `${c.name} · ${c.cost} credits / run` : c.name;
    }
    if (!engineInstalled) return "Local engine not installed — click Install engine";
    if (downloading) return "Downloading model…";
    if (localNeedsDownload) return `${pendingLocalModel?.name} — click Download model`;
    if (sidecar.state === "starting") return "Local engine starting…";
    if (sidecar.state === "error") return "Local engine error — see Logs";
    if (sidecar.state !== "ready") return "Start the local engine to generate";
    return settings?.localModel?.name ?? "Pick a model above";
  }, [mode, cloudConfigured, downloading, localNeedsDownload, pendingLocalModel, sidecar.state, settings?.cloudModelInfo, settings?.localModel, engineInstalled]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob aurora-blob-1" />
        <span className="aurora-blob aurora-blob-2" />
        <span className="aurora-blob aurora-blob-3" />
      </div>
      <Header
        appVersion={appVersion}
        sidecar={sidecar}
        engineInstalled={engineInstalled}
        installing={installing}
        hasLocalModel={!!settings?.localModel}
        onInstallEngine={installEngine}
        onStartEngine={startEngine}
        onStopEngine={stopEngine}
        onSelectModel={() => setMode("local")}
        errorLogCount={errorLogCount}
        onToggleLogs={() => setLogsOpen((o) => !o)}
        onOpenSettings={() => openSettings()}
      />

      {updateInfo?.updateAvailable && updateInfo.latestVersion && (
        <div className="relative z-10 mx-auto w-full max-w-[100rem] px-6 pt-4">
          <UpdateBanner info={updateInfo} onDismiss={dismissUpdate} />
        </div>
      )}

      <main className="relative z-10 flex-1 overflow-y-auto">
        {/* Desktop two-zone layout: controls on the left (fixed, sticky), the
            results grid fills the rest. Stacks vertically on narrow windows. */}
        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6 px-6 pt-6 pb-16 lg:flex-row lg:items-start">
          {/* Controls — capped/centered when stacked; a fixed left rail on desktop. */}
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 lg:sticky lg:top-4 lg:mx-0 lg:w-[26rem] lg:max-w-none lg:shrink-0">
            {/* 1. Mode — first, single source of truth (not repeated in the composer). */}
            <ModeToggle
              mode={mode}
              onModeChange={setMode}
              localReady={localReady}
              cloudReady={cloudReady}
            />

            {/* 1b. Payment — cloud only: pick x402 or API key, deep-link to config. */}
            {mode === "cloud" && (
              <PaymentBar
                settings={settings}
                onModeChange={setPaymentMode}
                onConfigure={openSettings}
              />
            )}

            {/* 2. Model */}
            <ModelBar
              mode={mode}
              settings={settings}
              onModelSwitched={handleSettingsSaved}
              pendingLocalModel={pendingLocalModel}
              onSelectLocal={setPendingLocalModel}
              downloading={downloading}
              progress={dlProgress}
              onAddCustom={addCustomModel}
              onSelectCustom={selectCustomModel}
              onRemoveCustom={removeCustomModel}
            />

            {/* 2b. Parameters — seeded from the model, tweakable per generation. */}
            {activeModel && params && (
              <ParamsPanel model={activeModel} mode={mode} params={params} onChange={setParams} />
            )}

            {/* 3. Prompt (with pre-prompt above + negative below) */}
            <Composer
              prompt={prompt}
              onPromptChange={setPrompt}
              mode={mode}
              action={primary}
              contextHint={contextHint}
              sourceImage={sourceImage}
              onSourceImageChange={setSourceImage}
              strength={strength}
              onStrengthChange={setStrength}
              showModelFields={!!params}
              prePrompt={params?.prePrompt ?? ""}
              onPrePromptChange={(v) => setParams((pp) => (pp ? { ...pp, prePrompt: v } : pp))}
              negativePrompt={params?.negativePrompt ?? ""}
              onNegativePromptChange={(v) => setParams((pp) => (pp ? { ...pp, negativePrompt: v } : pp))}
            />
          </div>

          {/* 4. Generations — this session's jobs + the saved-image gallery. */}
          <div className="min-w-0 flex-1">
            <Gallery jobs={jobs} />
          </div>
        </div>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(o) => {
          setSettingsOpen(o);
          if (!o) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
        onSaved={handleSettingsSaved}
      />
      <CustomModelDialog
        path={customModelPath}
        onClose={() => setCustomModelPath(null)}
        onConfirm={confirmCustomModel}
      />
      <LogPanel open={logsOpen} onOpenChange={setLogsOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — frosted, sticky, content-deferential.
// ---------------------------------------------------------------------------

function Header({
  appVersion,
  sidecar,
  engineInstalled,
  installing,
  hasLocalModel,
  onInstallEngine,
  onStartEngine,
  onStopEngine,
  onSelectModel,
  errorLogCount,
  onToggleLogs,
  onOpenSettings,
}: {
  appVersion: string;
  sidecar: SidecarStatus;
  engineInstalled: boolean;
  installing: boolean;
  hasLocalModel: boolean;
  onInstallEngine: () => void;
  onStartEngine: () => void;
  onStopEngine: () => void;
  onSelectModel: () => void;
  errorLogCount: number;
  onToggleLogs: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <header className="bg-background/70 supports-[backdrop-filter]:bg-background/55 sticky top-0 z-10 flex items-center justify-between border-b px-5 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-2.5">
        {/* Logo + app version stacked — the version is important operational info. */}
        <div className="flex flex-col items-center leading-none">
          <img src={logoUrl} alt="Imference" className="size-8" />
          <span className="text-muted-foreground mt-0.5 text-[9px] tabular-nums" title="Imference Desktop version">
            {appVersion === "dev" ? "dev" : appVersion ? `v${appVersion}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <EngineControl
            status={sidecar}
            engineInstalled={engineInstalled}
            installing={installing}
            hasLocalModel={hasLocalModel}
            onInstall={onInstallEngine}
            onStart={onStartEngine}
            onStop={onStopEngine}
            onSelectModel={onSelectModel}
          />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {/* Settings — prominent, labelled entry point. */}
        <Button variant="outline" size="sm" onClick={onOpenSettings} className="h-9 gap-1.5">
          <Settings className="size-4" />
          Settings
        </Button>
        {/* Logs — discreet, for debugging; a dot signals errors. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleLogs}
          aria-label={errorLogCount > 0 ? `Logs, ${errorLogCount} errors` : "Logs"}
          title={errorLogCount > 0 ? `${errorLogCount} error${errorLogCount > 1 ? "s" : ""}` : "Logs"}
          className="text-muted-foreground/60 hover:text-foreground relative size-8"
        >
          <ScrollText className="size-4" />
          {errorLogCount > 0 && (
            <span className="bg-destructive ring-background absolute right-1 top-1 size-2 rounded-full ring-2" />
          )}
        </Button>
      </div>
    </header>
  );
}

// EngineControl — the local engine's status *and* its lifecycle switch. Because
// the backend (sdxl/zimage/wan) and weights are chosen BY the model, "starting
// the engine" means "load the selected model"; there is no model-agnostic start.
// So: not installed → Install · no model → Select a model · model ready, stopped
// → Start (loads it) · running → Stop (frees VRAM).
function EngineControl({
  status,
  engineInstalled,
  installing,
  hasLocalModel,
  onInstall,
  onStart,
  onStop,
  onSelectModel,
}: {
  status: SidecarStatus;
  engineInstalled: boolean;
  installing: boolean;
  hasLocalModel: boolean;
  onInstall: () => void;
  onStart: () => void;
  onStop: () => void;
  onSelectModel: () => void;
}) {
  const pill =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

  if (installing) {
    return (
      <span className={cn(pill, "border-border text-muted-foreground")}>
        <Loader2 className="size-3 animate-spin" /> Installing engine…
      </span>
    );
  }
  if (!engineInstalled) {
    return (
      <button
        type="button"
        onClick={onInstall}
        className={cn(pill, "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20")}
      >
        <Download className="size-3" /> Install engine
      </button>
    );
  }
  if (status.state === "starting") {
    return (
      <span className={cn(pill, "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
        <Loader2 className="size-3 animate-spin" /> Starting…
      </span>
    );
  }
  if (status.state === "ready") {
    return (
      <button
        type="button"
        onClick={onStop}
        title={`Local engine running · ${status.device} — click to stop`}
        className={cn(
          pill,
          // Fixed width + centered so swapping the label on hover doesn't reflow.
          "group min-w-[7.5rem] justify-center border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600 dark:text-emerald-300"
        )}
      >
        <span className="size-1.5 rounded-full bg-emerald-500 group-hover:hidden" />
        <Square className="hidden size-3 group-hover:inline" />
        <span className="group-hover:hidden">Local engine on</span>
        <span className="hidden group-hover:inline">Stop</span>
      </button>
    );
  }
  // No downloaded model → "start" is meaningless (the model picks the backend +
  // weights). Guide to model selection instead of a dead greyed button.
  if (!hasLocalModel) {
    return (
      <button
        type="button"
        onClick={onSelectModel}
        title="Pick a local model — that's what the engine loads and runs"
        className={cn(pill, "border-border text-muted-foreground hover:text-foreground hover:border-primary/40")}
      >
        <Cpu className="size-3" /> Select a model
      </button>
    );
  }

  // Model ready but engine stopped / errored → Start (loads that model).
  const isError = status.state === "error";
  const errMsg = status.state === "error" ? status.message : undefined;
  return (
    <button
      type="button"
      onClick={onStart}
      title={errMsg || "Start the local engine (loads the selected model)"}
      className={cn(
        pill,
        isError
          ? "border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
          : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
      )}
    >
      <Play className="size-3" />
      {isError ? "Restart engine" : "Start engine"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer — the prompt input + primary action. Mode lives above (ModeToggle),
// not here; several generations can be launched back-to-back.
// ---------------------------------------------------------------------------

function Composer({
  prompt,
  onPromptChange,
  mode,
  action,
  contextHint,
  sourceImage,
  onSourceImageChange,
  strength,
  onStrengthChange,
  showModelFields,
  prePrompt,
  onPrePromptChange,
  negativePrompt,
  onNegativePromptChange,
}: {
  prompt: string;
  onPromptChange: (v: string) => void;
  mode: Mode;
  action: ComposerAction;
  contextHint: string;
  sourceImage: string | null;
  onSourceImageChange: (v: string | null) => void;
  strength: number;
  onStrengthChange: (v: number) => void;
  showModelFields: boolean;
  prePrompt: string;
  onPrePromptChange: (v: string) => void;
  negativePrompt: string;
  onNegativePromptChange: (v: string) => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!action.disabled) action.onClick();
    }
  };

  return (
    <div className="composer bg-card rounded-[26px] border">
      {/* Pre-prompt (quality tags) — secondary: small, dim, tucked at the top. */}
      {showModelFields && (
        <label className="hover:bg-muted/30 block rounded-t-[26px] px-5 pb-2 pt-2.5 transition-colors">
          <span className="text-muted-foreground/60 text-[10px] font-medium uppercase tracking-wide">
            Quality tags
          </span>
          <textarea
            value={prePrompt}
            onChange={(e) => onPrePromptChange(e.target.value)}
            placeholder="masterpiece, best quality, …"
            rows={1}
            className="placeholder:text-muted-foreground/40 text-muted-foreground/90 block max-h-20 w-full resize-none border-0 bg-transparent text-[12.5px] leading-snug outline-none"
          />
        </label>
      )}

      {/* Prompt — the hero: largest text, most room, clear separation. */}
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="A serene mountain lake at golden hour, photorealistic…"
        rows={3}
        className={cn(
          "placeholder:text-muted-foreground/60 border-border/60 block max-h-72 min-h-32 w-full resize-none border-0 bg-transparent px-5 py-4 text-[17px] font-medium leading-relaxed outline-none",
          showModelFields ? "border-y" : "rounded-t-[26px]"
        )}
      />

      {/* Negative prompt — secondary, mirrors the pre-prompt styling. */}
      {showModelFields && (
        <label className="hover:bg-muted/30 block px-5 pb-2.5 pt-2 transition-colors">
          <span className="text-muted-foreground/60 text-[10px] font-medium uppercase tracking-wide">
            Negative prompt
          </span>
          <textarea
            value={negativePrompt}
            onChange={(e) => onNegativePromptChange(e.target.value)}
            placeholder="things to avoid…"
            rows={1}
            className="placeholder:text-muted-foreground/40 text-muted-foreground/90 block max-h-20 w-full resize-none border-0 bg-transparent text-[12.5px] leading-snug outline-none"
          />
        </label>
      )}

      {mode === "local" && (
        <Img2ImgBar
          sourceImage={sourceImage}
          onSourceImageChange={onSourceImageChange}
          strength={strength}
          onStrengthChange={onStrengthChange}
        />
      )}
      <div className="flex items-end justify-between gap-3 px-3 pt-2 pb-3">
        <span className="text-muted-foreground/80 min-w-0 truncate pl-1 text-[11px]" title={contextHint}>
          {contextHint}
        </span>
        <Button
          size="lg"
          onClick={action.onClick}
          disabled={action.disabled}
          className="btn-brand h-11 shrink-0 rounded-full px-6 text-[15px] font-semibold disabled:opacity-40 disabled:saturate-0"
        >
          {action.busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : action.kind === "download" ? (
            <Download className="size-4" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {action.label}
          {action.kind === "generate" && (
            <kbd className="ml-1 hidden items-center gap-0.5 rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex">
              <CornerDownLeft className="size-2.5" />
            </kbd>
          )}
        </Button>
      </div>
    </div>
  );
}

// ParamsPanel — collapsible generation parameters, seeded from the model's
// catalog defaults (steps/cfg bounds, negative prompt, format) and tweakable per
// generation. Clip-skip / scheduler are local-only (the cloud API uses the
// model's server-side defaults).
function ParamsPanel({
  model,
  mode,
  params,
  onChange,
}: {
  model: ModelInfo;
  mode: Mode;
  params: GenParams;
  onChange: (p: GenParams) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<GenParams>) => onChange({ ...params, ...patch });

  const stepsMin = model.stepsMin || 1;
  const stepsMax = Math.max(model.stepsMax || 50, stepsMin + 1);
  const cfgMin = model.cfgMin || 1;
  const cfgMax = Math.max(model.cfgMax || 20, cfgMin + 0.5);
  const showClip = model.skipDefault > 0; // model uses clip-skip
  const formats = formatOptions(model);
  const dims = dimsForModel(model, params.formatCode);
  const summary = `${dims.width}×${dims.height} · ${params.steps} steps · cfg ${params.cfg}`;

  return (
    <section className="bg-card rounded-2xl border shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontal className="text-muted-foreground size-4 shrink-0" />
          <span className="text-sm font-semibold">Parameters</span>
          <span className="text-muted-foreground/80 truncate text-[11px]">{summary}</span>
        </div>
        <ChevronDown
          className={cn("text-muted-foreground size-4 shrink-0 transition", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="grid gap-4 border-t px-4 py-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">Format</span>
            <div className="bg-muted flex flex-wrap gap-1 rounded-lg p-0.5 text-xs">
              {formats.map((f) => (
                <button
                  key={f.formatCode}
                  type="button"
                  onClick={() => set({ formatCode: f.formatCode })}
                  title={`${f.width}×${f.height}${f.ratio ? ` · ${f.ratio}` : ""}`}
                  className={cn(
                    "flex-1 whitespace-nowrap rounded-md px-2 py-1.5 font-medium capitalize transition",
                    params.formatCode === f.formatCode
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {f.name || f.formatCode}
                  {f.ratio && (
                    <span className="text-muted-foreground/70 ml-1 text-[10px] normal-case">{f.ratio}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <RangeRow label="Steps" value={params.steps} min={stepsMin} max={stepsMax} step={1} onChange={(v) => set({ steps: v })} />
          <RangeRow label="CFG" value={params.cfg} min={cfgMin} max={cfgMax} step={0.5} onChange={(v) => set({ cfg: v })} />

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Seed</span>
              <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={params.seedMode === "random"}
                  onChange={(e) => set({ seedMode: e.target.checked ? "random" : "fixed" })}
                />
                Random
              </label>
            </div>
            {params.seedMode === "fixed" && (
              <input
                type="number"
                value={params.seed}
                onChange={(e) => set({ seed: Number(e.target.value) || 0 })}
                className="border-input bg-background h-8 rounded-md border px-2 text-xs outline-none"
              />
            )}
          </div>

          {mode === "local" && (
            <div className="grid gap-3 border-t pt-3">
              <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                Advanced · local only
              </span>
              {showClip && (
                <RangeRow
                  label="Clip skip"
                  value={params.clipSkip ?? model.skipDefault}
                  min={0}
                  max={4}
                  step={1}
                  onChange={(v) => set({ clipSkip: v })}
                />
              )}
              <div className="grid gap-1.5">
                <span className="text-xs font-medium">Scheduler</span>
                {/* Read-only until we expose a scheduler list — shows the model default. */}
                <div className="border-input bg-muted/40 text-muted-foreground flex h-8 items-center rounded-md border px-2 text-xs">
                  {params.scheduler || "model default"}
                </div>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => onChange(defaultParams(model))}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 justify-self-start text-[11px]"
          >
            <RotateCcw className="size-3" /> Reset to model defaults
          </button>
        </div>
      )}
    </section>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-muted-foreground text-xs tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer accent-[var(--brand-to)]"
      />
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

// ModeToggle — the primary local/cloud switch, at the top of the form and the
// single source of truth for mode (not repeated in the composer).
function ModeToggle({
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
    <div className="bg-muted grid grid-cols-2 gap-1 rounded-2xl p-1 text-sm">
      <SegBtn
        active={mode === "local"}
        ready={localReady}
        onClick={() => onModeChange("local")}
        icon={<Cpu className="size-4" />}
        label="Local"
      />
      <SegBtn
        active={mode === "cloud"}
        ready={cloudReady}
        onClick={() => onModeChange("cloud")}
        icon={<Cloud className="size-4" />}
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
        "relative inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 font-medium transition-all",
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
// Gallery — this session's jobs + the saved-image history, in an aspect-aware
// masonry (any format). Adjustable columns, infinite scroll over the saved
// history, click-to-fullscreen, and delete.
// ---------------------------------------------------------------------------

const GALLERY_PAGE = 24;

const EMPTY_FILTER: GalleryFilter = { engine: "", modelCode: "", source: "" };

type LightboxItem = { src: string; meta?: GenerationMeta | null };

function Gallery({ jobs }: { jobs: Job[] }) {
  const [saved, setSaved] = useState<SavedImage[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cols, setCols] = useState(3);
  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_FILTER);
  const [facets, setFacets] = useState<GalleryFacets | null>(null);
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false); // guards against overlapping page loads
  const savedRef = useRef<SavedImage[]>([]);
  savedRef.current = saved;

  const refreshFacets = useCallback(() => {
    void api.galleryFacets().then(setFacets).catch(() => {});
  }, []);
  useEffect(refreshFacets, [refreshFacets]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    api
      .listSavedImages(savedRef.current.length, GALLERY_PAGE, filter)
      .then((page) => {
        setSaved((cur) => {
          const seen = new Set(cur.map((x) => x.name));
          return [...cur, ...page.filter((p) => !seen.has(p.name))];
        });
        if (page.length < GALLERY_PAGE) setDone(true);
      })
      .catch(() => setDone(true))
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [done, filter]);

  // Initial load + reset-and-reload whenever the filter changes.
  useEffect(() => {
    savedRef.current = [];
    setSaved([]);
    setDone(false);
    loadingRef.current = false;
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Infinite scroll: load the next page as the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "800px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done]);

  const onDelete = useCallback(
    (img: SavedImage) => {
      if (!window.confirm(`Delete this image?\n${img.name}`)) return;
      void api
        .deleteSavedImage(img.name)
        .then(() => {
          setSaved((s) => s.filter((x) => x.name !== img.name));
          refreshFacets();
        })
        .catch(() => {});
    },
    [refreshFacets]
  );

  const filtered = filter.engine !== "" || filter.modelCode !== "" || filter.source !== "";

  // Build the tile list (session jobs first, then saved), then spread it across
  // `cols` columns round-robin so the reading order is LEFT-TO-RIGHT (item 0 →
  // col 0, item 1 → col 1, …). CSS `columns` would fill top-to-bottom instead.
  // Each column stacks its tiles at natural height → true masonry.
  const tiles: { key: string; el: React.ReactElement }[] = [];
  if (!filtered) {
    for (const j of jobs) tiles.push({ key: j.id, el: <JobTile job={j} onOpen={setLightbox} /> });
  }
  for (const g of saved) {
    tiles.push({ key: g.name, el: <SavedTile image={g} onOpen={setLightbox} onDelete={onDelete} /> });
  }
  const columns: { key: string; el: React.ReactElement }[][] = Array.from({ length: cols }, () => []);
  tiles.forEach((t, i) => columns[i % cols].push(t));
  const empty = tiles.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar facets={facets} filter={filter} onChange={setFilter} />
        <ColumnPicker cols={cols} onChange={setCols} />
      </div>

      {empty ? (
        <div className="border-border/60 text-muted-foreground/70 relative flex min-h-[60vh] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-[26px] border border-dashed lg:min-h-[70vh]">
          <div className="canvas-glow pointer-events-none absolute inset-0" />
          <div className="brand-surface relative flex size-12 items-center justify-center rounded-2xl text-white shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--brand-to)_60%,transparent)]">
            <ImageIcon className="size-5" strokeWidth={1.75} />
          </div>
          <p className="relative text-sm">
            {filtered ? "No images match this filter" : "Your generations will appear here"}
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          {columns.map((col, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3">
              {col.map((t) => (
                <div key={t.key}>{t.el}</div>
              ))}
            </div>
          ))}
        </div>
      )}

      {!done && <div ref={sentinelRef} className="h-4 w-full" />}
      {loading && (
        <div className="text-muted-foreground flex justify-center py-2">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}

      {lightbox && <Lightbox item={lightbox} onClose={() => setLightbox(null)} />}
      <style>{`@keyframes shimmer{100%{transform:translateX(100%)}}`}</style>
    </div>
  );
}

function FilterBar({
  facets,
  filter,
  onChange,
}: {
  facets: GalleryFacets | null;
  filter: GalleryFilter;
  onChange: (f: GalleryFilter) => void;
}) {
  const active = filter.engine !== "" || filter.modelCode !== "" || filter.source !== "";
  // Guard against nil slices (Go marshals empty slices as null).
  const models = facets?.models ?? [];
  const engines = facets?.engines ?? [];
  const sources = facets?.sources ?? [];
  if (models.length === 0 && engines.length === 0 && sources.length === 0) return <div />;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {models.length > 0 && (
        <FacetSelect
          label="Model"
          value={filter.modelCode}
          facets={models}
          onChange={(v) => onChange({ ...filter, modelCode: v })}
        />
      )}
      {engines.length > 1 && (
        <FacetSelect
          label="Engine"
          value={filter.engine}
          facets={engines}
          onChange={(v) => onChange({ ...filter, engine: v })}
        />
      )}
      {sources.length > 1 && (
        <FacetSelect
          label="Source"
          value={filter.source}
          facets={sources}
          onChange={(v) => onChange({ ...filter, source: v })}
        />
      )}
      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTER)}
          className="text-muted-foreground hover:text-foreground text-xs font-medium"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function FacetSelect({
  label,
  value,
  facets,
  onChange,
}: {
  label: string;
  value: string;
  facets: { value: string; label: string; count: number }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-input bg-background h-8 max-w-40 rounded-md border px-2 text-xs"
      aria-label={label}
    >
      <option value="">{label}: all</option>
      {facets.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label} ({f.count})
        </option>
      ))}
    </select>
  );
}

function ColumnPicker({ cols, onChange }: { cols: number; onChange: (n: number) => void }) {
  return (
    <div className="bg-muted inline-flex items-center gap-0.5 rounded-lg p-0.5" role="group" aria-label="Columns">
      {[1, 2, 3, 4].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-label={`${n} column${n > 1 ? "s" : ""}`}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium tabular-nums transition",
            cols === n
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function JobTile({ job, onOpen }: { job: Job; onOpen: (item: LightboxItem) => void }) {
  if (job.status === "running") {
    const pct = job.progress && job.progress.total > 0 ? job.progress.percent : null;
    const sub =
      pct !== null
        ? `step ${job.progress!.step}/${job.progress!.total}`
        : job.mode === "cloud"
          ? "Cloud…"
          : "Generating…";
    return (
      <div className="bg-muted/40 relative aspect-square w-full overflow-hidden rounded-2xl border" title={job.prompt}>
        <div className="via-foreground/[0.04] absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent to-transparent" />
        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-[11px]">{sub}</span>
          {pct !== null && (
            <div className="bg-muted mt-0.5 h-1 w-24 max-w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (job.status === "error") {
    return (
      <div
        className="border-destructive/30 bg-destructive/5 text-destructive flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-2xl border p-4 text-center"
        title={job.error}
      >
        <AlertCircle className="size-5" />
        <span className="line-clamp-4 text-[11px] leading-snug">{job.error}</span>
      </div>
    );
  }

  const img = job.image!;
  return (
    <figure
      className="group animate-in fade-in zoom-in-95 ring-border/60 relative cursor-zoom-in overflow-hidden rounded-2xl ring-1 duration-500"
      onClick={() =>
        onOpen({
          src: img.imageBase64,
          meta: img.meta ?? { prompt: job.prompt, source: img.source, seed: img.seed, createdAt: "" },
        })
      }
    >
      <img src={img.imageBase64} alt={job.prompt} title={job.prompt} className="block w-full" />
      <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        <span className="rounded-full bg-white/20 px-1.5 py-0.5 font-medium capitalize">{img.source}</span>
        <span className="tabular-nums">seed {img.seed}</span>
      </figcaption>
    </figure>
  );
}

// A saved image from the output folder. Bytes are fetched lazily (base64 over the
// Wails bridge) only when the tile scrolls into view; its aspect box is reserved
// from the known dimensions so the masonry lays out any format without jumps.
function SavedTile({
  image,
  onOpen,
  onDelete,
}: {
  image: SavedImage;
  onOpen: (item: LightboxItem) => void;
  onDelete: (img: SavedImage) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let fetched = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !fetched) {
          fetched = true;
          io.disconnect();
          void api.getSavedImage(image.name).then(setSrc).catch(() => {});
        }
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [image.name]);

  const aspect = image.width > 0 && image.height > 0 ? image.width / image.height : 1;

  const open = () => {
    if (src) {
      onOpen({ src, meta: image.meta });
      return;
    }
    void api.getSavedImage(image.name).then((d) => {
      setSrc(d);
      onOpen({ src: d, meta: image.meta });
    }).catch(() => {});
  };

  return (
    <figure
      ref={ref}
      className="group ring-border/60 bg-muted/40 relative cursor-zoom-in overflow-hidden rounded-2xl ring-1"
      title={image.name}
      style={{ aspectRatio: aspect }}
      onClick={open}
    >
      {src ? (
        <img src={src} alt={image.name} className="h-full w-full object-cover" />
      ) : (
        <div className="text-muted-foreground/30 flex h-full w-full items-center justify-center">
          <ImageIcon className="size-5" />
        </div>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(image);
        }}
        aria-label="Delete image"
        className="absolute right-1.5 top-1.5 hidden rounded-full bg-black/50 p-1.5 text-white hover:bg-red-600/80 group-hover:block"
      >
        <Trash2 className="size-3.5" />
      </button>
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {image.source && (
          <span className="rounded-full bg-white/20 px-1.5 py-0.5 font-medium capitalize">
            {image.source}
          </span>
        )}
        {image.seed > 0 && <span className="tabular-nums">seed {image.seed}</span>}
      </figcaption>
    </figure>
  );
}

// Fullscreen viewer with a generation-details panel. Backdrop click or Esc closes.
function Lightbox({ item, onClose }: { item: LightboxItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta = item.meta;

  return (
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-6xl flex-col items-center gap-4 md:flex-row md:items-stretch"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={item.src}
          alt=""
          className="max-h-[85vh] min-h-0 flex-1 rounded-xl object-contain shadow-2xl"
        />
        {meta && <MetaPanel meta={meta} />}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}

function MetaPanel({ meta }: { meta: GenerationMeta }) {
  const rows: [string, string][] = [];
  const add = (k: string, v: string | number | undefined | null) => {
    if (v !== undefined && v !== null && v !== "" && v !== 0) rows.push([k, String(v)]);
  };
  add("Model", meta.modelName || meta.modelCode);
  add("Engine", meta.engine);
  add("Source", meta.source);
  add("Size", meta.width && meta.height ? `${meta.width}×${meta.height}` : "");
  add("Format", meta.formatCode);
  add("Steps", meta.numSteps);
  add("CFG", meta.guidanceScale);
  add("Scheduler", meta.scheduler);
  add("Clip skip", meta.clipSkip);
  add("Seed", meta.seed);
  if (meta.img2img) add("img2img", `strength ${meta.strength ?? ""}`);
  add("Created", meta.createdAt ? meta.createdAt.replace("T", " ").slice(0, 19) : "");

  return (
    <div className="bg-background/95 flex w-full shrink-0 flex-col gap-3 overflow-y-auto rounded-xl p-4 text-sm shadow-2xl md:max-h-[85vh] md:w-80">
      {meta.prompt && (
        <div>
          <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">Prompt</div>
          <p className="leading-relaxed">{meta.prompt}</p>
        </div>
      )}
      {meta.negativePrompt && (
        <div>
          <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">Negative</div>
          <p className="text-muted-foreground leading-relaxed">{meta.negativePrompt}</p>
        </div>
      )}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right font-medium tabular-nums" title={v}>{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

// UpdateBanner announces a newer release. Download opens the GitHub release
// page in the system browser — no in-app download while the app is unsigned.
function UpdateBanner({ info, onDismiss }: { info: UpdateInfo; onDismiss: () => void }) {
  const url = info.url ?? "https://github.com/Publikey/imference-desktop/releases/latest";
  return (
    <div className="animate-in fade-in slide-in-from-top-1 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300">
      <Download className="size-4 shrink-0" />
      <p className="flex-1 leading-relaxed">
        Imference Desktop <span className="font-semibold">v{info.latestVersion}</span> is available
        {info.currentVersion !== "dev" && (
          <span className="opacity-70"> (you have v{info.currentVersion})</span>
        )}
        .
      </p>
      <Button
        size="sm"
        className="h-7 shrink-0 rounded-lg bg-amber-500 px-3 text-xs font-semibold text-white hover:bg-amber-400"
        onClick={() => void Browser.OpenURL(url)}
      >
        Download
      </Button>
      <button
        onClick={onDismiss}
        className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
        title="Dismiss (shown again at next launch)"
      >
        <X className="size-4" />
      </button>
    </div>
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
