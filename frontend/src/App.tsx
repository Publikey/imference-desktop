import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  Languages,
  Wand2,
  Activity,
  Images,
  Sun,
  Moon,
  Monitor,
  Search,
  Check,
  Copy,
  FolderOpen,
  Maximize2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CustomModelDialog } from "@/components/CustomModelDialog";
import { ModelBar } from "@/components/ModelBar";
import { PaymentBar } from "@/components/PaymentBar";
import { LogPanel } from "@/components/LogPanel";
import { PanelBoard, usePanelLayout } from "@/components/PanelBoard";
import { QueuePanel } from "@/components/QueuePanel";
import { CommandPalette, modLabel, type Command } from "@/components/CommandPalette";
import { api } from "@/lib/wails-bridge";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { subscribeTheme, themePref, setThemePref, type ThemePref } from "@/lib/theme";
import logoUrl from "./assets/logo.svg";
import { installLogCapture } from "@/lib/log-capture";
import { cn, creditsToUSD } from "@/lib/utils";
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
  Job,
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

let jobSeq = 0;
const nextJobId = () => `job-${Date.now()}-${jobSeq++}`;

// User-tweakable generation parameters, seeded from the selected model's catalog
// defaults and reset when the model changes.
type GenParams = {
  prePrompt: string; // quality-tag prefix, prepended to the user prompt (client-side)
  formatCode: string; // a catalog format code, or "custom" (local only) for free dims
  steps: number;
  cfg: number;
  negativePrompt: string;
  seedMode: "random" | "fixed";
  seed: number;
  clipSkip: number | null; // local only
  scheduler: string; // local only
  // Free width/height when formatCode === "custom" (local only). Seeded from the
  // active preset, snapped to a multiple of 8 (latent constraint) at use.
  customWidth: number;
  customHeight: number;
};

// The "custom" pseudo-format (local only): free width/height instead of a preset.
const CUSTOM_FORMAT = "custom";

// Generic formats used only when the catalog (im_format) carries none. Names
// are left empty so the UI resolves them via i18n (formatName below).
const FALLBACK_FORMATS: FormatOption[] = [
  { formatCode: "square", name: "", width: 1024, height: 1024, ratio: "1:1", isDefault: true },
  { formatCode: "portrait", name: "", width: 832, height: 1216, ratio: "2:3", isDefault: false },
  { formatCode: "landscape", name: "", width: 1216, height: 832, ratio: "3:2", isDefault: false },
];

// Display name of a format: known codes are translated, otherwise the catalog
// name (server-provided) then the raw code.
function formatName(f: FormatOption, t: TFunction): string {
  return t(`formats.${f.formatCode}`, { defaultValue: f.name || f.formatCode });
}

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

// Clamp a free dimension to a diffusion-safe multiple of 8 within [256, 2048].
function snapDim(n: number): number {
  const v = Math.round((Number.isFinite(n) ? n : 1024) / 8) * 8;
  return Math.max(256, Math.min(2048, v));
}

// The dimensions a generation will actually use: the picked preset, or the
// (snapped) free width/height when the user chose "custom".
function resolveDims(
  model: ModelInfo | null | undefined,
  params: GenParams
): { width: number; height: number } {
  if (params.formatCode === CUSTOM_FORMAT) {
    return { width: snapDim(params.customWidth), height: snapDim(params.customHeight) };
  }
  return dimsForModel(model, params.formatCode);
}

// Read a picked/dropped File into a data-URL (the img2img source shape).
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Custom drag types a gallery tile carries so a drop onto the Create panel can
// resolve back to an image (inline data-URL when we already have it, else the
// saved-file name to fetch).
const DRAG_SRC = "application/x-imference-src";
const DRAG_NAME = "application/x-imference-name";

// True when a drag carries something we can turn into an img2img source (an OS
// image file or a gallery tile). Only `types` are readable during dragover.
function dragHasImage(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  return types.includes("Files") || types.includes(DRAG_SRC) || types.includes(DRAG_NAME);
}

// defaultParams seeds the tweakable params from a model's catalog config.
function defaultParams(model: ModelInfo): GenParams {
  const d = dimsForModel(model, defaultFormatCode(model));
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
    customWidth: d.width,
    customHeight: d.height,
  };
}

export default function App() {
  const { t } = useTranslation();
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
  // Panel arrangement (Create / Activity / Gallery) — drag-reorderable, persisted.
  const { columns: panelColumns, collapsed: panelCollapsed, setColumns: setPanelColumns, toggleCollapsed: togglePanelCollapsed } = usePanelLayout();
  // Fullscreen viewer — shared by the gallery and the Activity panel.
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);
  // Command palette (⌘K) + the model-picker open state it drives (lifted here so
  // the palette can open the picker, not just ModelBar's own trigger).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

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
      message: t("hint.preparing", { name: pendingLocalModel.name }),
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
  }, [pendingLocalModel, downloading, t]);

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

  // The composer never gates on in-flight work: cloud runs fire concurrently and
  // local runs are enqueued, so the user can keep launching either way.
  const canGenerate = (mode === "cloud" ? cloudReady : localReady) && !!prompt.trim();

  // Settle a job from its generate() promise — shared by the immediate cloud path
  // and the local queue dispatcher.
  const settleJob = useCallback((id: string, call: Promise<GenerationResult>) => {
    call
      .then((result) =>
        setJobs((js) =>
          js.map((j) => (j.id === id ? { ...j, status: "done", image: result, endedAt: Date.now() } : j))
        )
      )
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setJobs((js) =>
          js.map((j) => (j.id === id ? { ...j, status: "error", error: msg, endedAt: Date.now() } : j))
        );
      });
  }, []);

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

      const req: GenerationRequest = {
        prompt: full,
        ...(pr ? resolveDims(model, pr) : dimsForModel(model, "")),
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

      const id = nextJobId();
      const now = Date.now();
      if (which === "cloud") {
        // Cloud fires immediately — the API handles concurrency server-side.
        setJobs((js) => [
          { id, mode: "cloud", prompt: full, status: "running", progress: null, queuedAt: now, startedAt: now },
          ...js,
        ]);
        settleJob(id, api.generateCloud(req));
      } else {
        // Local is enqueued: the sidecar denoises one image at a time, so the
        // dispatcher starts it (and each queued job after it) one by one. The
        // request is frozen now so later param tweaks never leak into a job
        // already waiting in line.
        setJobs((js) => [
          { id, mode: "local", prompt: full, status: "queued", progress: null, queuedAt: now, request: req },
          ...js,
        ]);
      }
    },
    [prompt, settings?.localModel, settings?.cloudModelInfo, params, sourceImage, strength, settleJob]
  );

  // Local FIFO dispatcher — the sidecar runs one local job at a time. Whenever
  // no local job is running, start the oldest still-queued (non-cancelled) one.
  // dispatchedRef makes each job fire its generateLocal exactly once, even though
  // this effect re-runs on every jobs change (and under StrictMode double-invoke).
  const dispatchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (jobs.some((j) => j.mode === "local" && j.status === "running")) return;
    let next: Job | undefined;
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      if (j.mode === "local" && j.status === "queued" && !j.hidden) {
        next = j;
        break;
      }
    }
    if (!next || !next.request || dispatchedRef.current.has(next.id)) return;
    const job = next;
    const request = next.request;
    dispatchedRef.current.add(job.id);
    setJobs((js) =>
      js.map((j) => (j.id === job.id ? { ...j, status: "running", startedAt: Date.now(), progress: null } : j))
    );
    settleJob(job.id, api.generateLocal(request));
  }, [jobs, settleJob]);

  // --- Activity panel bookkeeping ------------------------------------------
  // Dismissing hides a finished OR queued row: for a queued local job this also
  // cancels it (the dispatcher skips hidden jobs, so it never runs). A running
  // job can't be dismissed (no cancel API yet). Finished images stay in the
  // gallery regardless — jobs are only the source of this session's fresh tiles.
  const dismissJob = useCallback(
    (id: string) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, hidden: true } : j))),
    []
  );
  const clearFinished = useCallback(
    () =>
      setJobs((js) =>
        js.map((j) => (j.status === "running" || j.status === "queued" ? j : { ...j, hidden: true }))
      ),
    []
  );

  // --- Gallery → composer bridges ------------------------------------------
  // Send an image into the img2img source and switch to local (img2img is
  // local-only). Used by the gallery context menu and by dropping onto the panel.
  const useAsImg2img = useCallback(async (getSrc: () => Promise<string>) => {
    try {
      const src = await getSrc();
      if (src) {
        setSourceImage(src);
        setMode("local");
      }
    } catch {
      /* fetch/read failure — ignore */
    }
  }, []);

  // Load a past image's metadata back into the composer (prompt + parameters) to
  // re-run or remix it. Doesn't switch model or mode; the original img2img source
  // isn't stored, so it's not restored.
  const reuseSettings = useCallback(
    (meta: GenerationMeta) => {
      if (meta.prompt != null) setPrompt(meta.prompt);
      setParams((pp) => {
        const base = pp ?? (activeModel ? defaultParams(activeModel) : null);
        if (!base) return pp;
        const opts = formatOptions(activeModel);
        const known = !!meta.formatCode && opts.some((o) => o.formatCode === meta.formatCode);
        const fmt = known
          ? { formatCode: meta.formatCode! }
          : meta.width && meta.height
            ? { formatCode: CUSTOM_FORMAT, customWidth: snapDim(meta.width), customHeight: snapDim(meta.height) }
            : {};
        return {
          ...base,
          prePrompt: "", // meta.prompt already includes the quality-tag prefix
          negativePrompt: meta.negativePrompt ?? base.negativePrompt,
          steps: meta.numSteps ?? base.steps,
          cfg: meta.guidanceScale ?? base.cfg,
          seedMode: "fixed" as const,
          seed: meta.seed ?? base.seed,
          scheduler: meta.scheduler ?? base.scheduler,
          clipSkip: meta.clipSkip ?? base.clipSkip,
          ...fmt,
        };
      });
    },
    [activeModel]
  );

  // Drop-an-image-to-img2img target (the Create panel). Only image drags arm it.
  const [dropActive, setDropActive] = useState(false);
  const onPanelDragOver = useCallback((e: React.DragEvent) => {
    if (!dragHasImage(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }, []);
  const onPanelDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore leaves into descendants — only clear when the pointer truly exits.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropActive(false);
  }, []);
  const onPanelDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasImage(e.dataTransfer)) return;
      e.preventDefault();
      setDropActive(false);
      const dt = e.dataTransfer;
      const file = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
      if (file) {
        void readFileAsDataURL(file).then((src) => void useAsImg2img(async () => src));
        return;
      }
      const inline = dt.getData(DRAG_SRC);
      if (inline) {
        void useAsImg2img(async () => inline);
        return;
      }
      const name = dt.getData(DRAG_NAME);
      if (name) void useAsImg2img(() => api.getSavedImage(name));
    },
    [useAsImg2img]
  );

  // Primary button: in local mode, download the pending model first (dedicated
  // action — no auto-download on select); otherwise generate. Cmd/Ctrl+Enter
  // triggers whichever is current.
  const primary: ComposerAction = useMemo(() => {
    if (mode === "local" && downloading)
      return { label: t("composer.downloadingBtn"), onClick: () => {}, disabled: true, busy: true, kind: "download" };
    if (mode === "local" && localNeedsDownload)
      return {
        label: t("composer.downloadModelBtn"),
        onClick: downloadLocalModel,
        disabled: !pendingLocalModel,
        busy: false,
        kind: "download",
      };
    return {
      label: t("composer.generateBtn"),
      onClick: () => {
        if (canGenerate) run(mode);
      },
      disabled: !canGenerate,
      busy: false,
      kind: "generate",
    };
  }, [mode, downloading, localNeedsDownload, pendingLocalModel, downloadLocalModel, canGenerate, run, t]);

  // Global ⌘/Ctrl+Enter → run the primary action from anywhere in the app, not
  // only when the prompt field has focus. Suppressed while a modal that captures
  // typing is open (palette, settings, model picker, custom-model, lightbox), and
  // preventDefault still swallows the newline when focus IS in the prompt. A ref
  // holds the latest action/guards so the listener subscribes just once.
  const primaryHotkeyRef = useRef<{ disabled: boolean; onClick: () => void; blocked: boolean }>({
    disabled: true,
    onClick: () => {},
    blocked: false,
  });
  primaryHotkeyRef.current = {
    disabled: primary.disabled,
    onClick: primary.onClick,
    blocked: paletteOpen || settingsOpen || modelPickerOpen || !!customModelPath || !!lightbox,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const s = primaryHotkeyRef.current;
        if (s.blocked || s.disabled) return;
        e.preventDefault();
        s.onClick();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hint shown under the composer: what this generation will use (params live in
  // the Parameters panel now, so no steps/cfg duplication here).
  const contextHint = useMemo(() => {
    if (mode === "cloud") {
      if (!cloudConfigured) return t("hint.configurePayment");
      const c = settings?.cloudModelInfo;
      if (!c) return t("hint.pickCloudModel");
      if (!(c.cost > 0)) return c.name;
      // x402 pays in on-chain USDC; bearer pays in credits — show the matching unit.
      return settings?.paymentMode === "x402"
        ? t("hint.usdPerRun", { name: c.name, usd: creditsToUSD(c.cost) })
        : t("hint.creditsPerRun", { name: c.name, cost: c.cost });
    }
    if (!engineInstalled) return t("hint.engineNotInstalled");
    if (downloading) return t("hint.downloadingModel");
    if (localNeedsDownload) return t("hint.clickDownload", { name: pendingLocalModel?.name });
    if (sidecar.state === "starting") return t("hint.engineStarting");
    if (sidecar.state === "error") return t("hint.engineError");
    if (sidecar.state !== "ready") return t("hint.startEngine");
    return settings?.localModel?.name ?? t("hint.pickModel");
  }, [mode, cloudConfigured, downloading, localNeedsDownload, pendingLocalModel, sidecar.state, settings?.cloudModelInfo, settings?.localModel, settings?.paymentMode, engineInstalled, t]);

  // Activity-panel derivations: in-flight count (running + queued) for the badge,
  // finished rows for the Clear action, and the done subset the gallery shows as
  // fresh tiles.
  const activeCount = useMemo(
    () => jobs.filter((j) => !j.hidden && (j.status === "running" || j.status === "queued")).length,
    [jobs]
  );
  const hasFinished = useMemo(
    () => jobs.some((j) => !j.hidden && (j.status === "done" || j.status === "error")),
    [jobs]
  );
  // Fresh session tiles for the gallery — done AND not dismissed/deleted (a
  // deleted tile is hidden; without this it would linger after its file is gone).
  const doneJobs = useMemo(() => jobs.filter((j) => j.status === "done" && !j.hidden), [jobs]);

  // --- Command palette registry --------------------------------------------
  // The single source of truth for app actions. The ⌘K palette renders it now;
  // direct keyboard shortcuts can bind to the same list later.
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];
    const gGenerate = t("palette.groupGenerate");
    const gMode = t("palette.groupMode");
    const gModel = t("palette.groupModel");
    const gEngine = t("palette.groupEngine");
    const gPanels = t("palette.groupPanels");
    const gAppearance = t("palette.groupAppearance");
    const gApp = t("palette.groupApp");

    if (canGenerate)
      cmds.push({
        id: "generate",
        group: gGenerate,
        label: t("palette.generate"),
        icon: <Sparkles />,
        shortcut: [modLabel, "↵"],
        run: () => run(mode),
      });

    cmds.push(
      mode === "local"
        ? { id: "mode-cloud", group: gMode, label: t("palette.switchCloud"), icon: <Cloud />, keywords: "cloud", run: () => setMode("cloud") }
        : { id: "mode-local", group: gMode, label: t("palette.switchLocal"), icon: <Cpu />, keywords: "local", run: () => setMode("local") }
    );

    cmds.push({
      id: "model",
      group: gModel,
      label: t("palette.chooseModel"),
      icon: <Wand2 />,
      keywords: "model checkpoint",
      run: () => setModelPickerOpen(true),
    });

    // Engine (local-only, contextual — mirrors the header EngineControl states).
    if (mode === "local") {
      if (!engineInstalled)
        cmds.push({ id: "engine-install", group: gEngine, label: t("engineControl.install"), icon: <Download />, run: installEngine });
      else if (sidecar.state === "ready")
        cmds.push({ id: "engine-stop", group: gEngine, label: t("engineControl.stop"), icon: <Square />, run: stopEngine });
      else if (settings?.localModel)
        cmds.push({ id: "engine-start", group: gEngine, label: t("engineControl.start"), icon: <Play />, run: startEngine });
    }

    cmds.push({
      id: "toggle-activity",
      group: gPanels,
      label: panelCollapsed.queue ? t("palette.expandActivity") : t("palette.collapseActivity"),
      icon: <Activity />,
      run: () => togglePanelCollapsed("queue"),
    });
    if (hasFinished)
      cmds.push({ id: "clear-activity", group: gPanels, label: t("palette.clearActivity"), icon: <Trash2 />, run: clearFinished });

    (["system", "light", "dark"] as const).forEach((p) =>
      cmds.push({
        id: `theme-${p}`,
        group: gAppearance,
        label: t("palette.theme", { mode: t(`theme.${p}`) }),
        icon: p === "system" ? <Monitor /> : p === "light" ? <Sun /> : <Moon />,
        keywords: "theme appearance dark light",
        run: () => setThemePref(p),
      })
    );
    SUPPORTED_LANGUAGES.forEach((l) =>
      cmds.push({
        id: `lang-${l.code}`,
        group: gAppearance,
        label: t("palette.language", { lang: l.label }),
        icon: <Languages />,
        keywords: "language locale",
        run: () => setLanguage(l.code),
      })
    );

    cmds.push({ id: "settings", group: gApp, label: t("palette.settings"), icon: <Settings />, keywords: "preferences", run: () => openSettings() });
    cmds.push({ id: "logs", group: gApp, label: t("palette.logs"), icon: <ScrollText />, keywords: "console debug", run: () => setLogsOpen((o) => !o) });

    return cmds;
  }, [
    t, canGenerate, run, mode, engineInstalled, sidecar.state, settings?.localModel,
    installEngine, stopEngine, startEngine, panelCollapsed.queue, togglePanelCollapsed,
    hasFinished, clearFinished, openSettings,
  ]);

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
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {updateInfo?.updateAvailable && updateInfo.latestVersion && (
        <div className="relative z-10 mx-auto w-full max-w-[110rem] px-6 pt-4">
          <UpdateBanner info={updateInfo} onDismiss={dismissUpdate} />
        </div>
      )}

      <main className="relative z-10 flex-1 overflow-y-auto">
        {/* Three drag-reorderable panels — Create / Activity / Gallery — side by
            side on desktop, stacked (in the same order) on narrow windows. */}
        <div className="mx-auto w-full max-w-[110rem] px-6 pt-5 pb-16">
          <PanelBoard
            columns={panelColumns}
            onColumnsChange={setPanelColumns}
            collapsed={panelCollapsed}
            onToggleCollapsed={togglePanelCollapsed}
            panels={{
              create: {
                title: t("panels.create"),
                icon: <Wand2 />,
                width: 25,
                content: (
                  // Mode-tinted, self-scrolling surface: the panel is felt in
                  // the active mode's accent and, on desktop, scrolls internally
                  // so a long open Parameters section stays reachable while the
                  // column is sticky.
                  <div
                    className={cn(
                      "create-surface relative flex flex-col gap-4 p-3 xl:max-h-[calc(100vh-6.5rem)] xl:overflow-y-auto xl:overflow-x-hidden",
                      dropActive && "create-drop-active"
                    )}
                    data-mode={mode}
                    onDragOver={onPanelDragOver}
                    onDragLeave={onPanelDragLeave}
                    onDrop={onPanelDrop}
                  >
                    {/* Drop hint: shown while an image is dragged over the panel. */}
                    {dropActive && (
                      <div className="bg-background/70 border-primary/50 pointer-events-none absolute inset-1 z-20 flex flex-col items-center justify-center gap-2 rounded-[1.35rem] border-2 border-dashed backdrop-blur-sm">
                        <ImageIcon className="text-primary size-6" />
                        <span className="text-foreground text-sm font-semibold">{t("img2img.dropHere")}</span>
                      </div>
                    )}
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
                      pickerOpen={modelPickerOpen}
                      onPickerOpenChange={setModelPickerOpen}
                    />

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

                    {/* 4. Format — a primary creative choice, right under the
                        prompt; local mode also allows free custom dimensions. */}
                    {activeModel && params && (
                      <FormatSelector
                        model={activeModel}
                        mode={mode}
                        params={params}
                        onChange={(patch) => setParams((pp) => (pp ? { ...pp, ...patch } : pp))}
                      />
                    )}

                    {/* 5. Parameters — seeded from the model, tweakable per
                        generation. Below the format (fine-tuning follows the
                        main creative act). */}
                    {activeModel && params && (
                      <ParamsPanel model={activeModel} mode={mode} params={params} onChange={setParams} />
                    )}
                  </div>
                ),
              },
              queue: {
                title: t("panels.queue"),
                icon: <Activity />,
                badge:
                  activeCount > 0 ? (
                    <span className="brand-surface flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white">
                      {activeCount}
                    </span>
                  ) : undefined,
                actions: hasFinished ? (
                  <button
                    type="button"
                    onClick={clearFinished}
                    className="text-muted-foreground/60 hover:text-foreground text-[11px] font-medium transition-colors"
                  >
                    {t("queue.clearFinished")}
                  </button>
                ) : undefined,
                collapsible: true,
                width: 18,
                content: <QueuePanel jobs={jobs} onDismiss={dismissJob} onOpenImage={setLightbox} />,
              },
              gallery: {
                title: t("panels.gallery"),
                icon: <Images />,
                grow: true,
                content: (
                  <Gallery
                    jobs={doneJobs}
                    onUseAsSource={useAsImg2img}
                    onReuseSettings={reuseSettings}
                    onHideJob={dismissJob}
                  />
                ),
              },
            }}
          />
        </div>
      </main>

      {/* Activity-panel viewer: a single image (no prev/next, no delete) but the
          same action bar — reuses the gallery Lightbox with a one-item sequence. */}
      {lightbox && (
        <Lightbox
          items={[{ name: null, meta: lightbox.meta, getSrc: async () => lightbox.src }]}
          index={0}
          onIndex={() => {}}
          onClose={() => setLightbox(null)}
          onUseAsSource={useAsImg2img}
          onReuseSettings={reuseSettings}
          onDelete={() => {}}
        />
      )}

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
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
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
  onOpenPalette,
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
  onOpenPalette: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="bg-background/70 supports-[backdrop-filter]:bg-background/55 sticky top-0 z-10 flex items-center justify-between border-b px-5 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-2.5">
        {/* Logo + app version stacked — the version is important operational info. */}
        <div className="flex flex-col items-center leading-none">
          <img src={logoUrl} alt="Imference" className="size-8" />
          <span className="text-muted-foreground mt-0.5 text-[10px] tabular-nums" title={t("header.versionTitle")}>
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
        {/* Command palette launcher — discoverable entry point for ⌘K. */}
        <button
          type="button"
          onClick={onOpenPalette}
          title={t("palette.title")}
          aria-label={t("palette.title")}
          className="text-muted-foreground hover:text-foreground hover:border-primary/40 hidden h-9 items-center gap-2 rounded-md border pl-2.5 pr-2 text-xs transition-colors sm:inline-flex"
        >
          <Search className="size-3.5" />
          <span className="flex items-center gap-0.5">
            <kbd className="bg-muted rounded px-1 py-0.5 text-[10px] font-medium leading-none">{modLabel}</kbd>
            <kbd className="bg-muted rounded px-1 py-0.5 text-[10px] font-medium leading-none">K</kbd>
          </span>
        </button>
        {/* Theme — cycles System → Light → Dark, persisted; System follows the OS. */}
        <ThemeToggle />
        {/* Language — quick toggle; the Settings section offers "System" too. */}
        <LanguageToggle />
        {/* Settings — prominent, labelled entry point. */}
        <Button variant="outline" size="sm" onClick={onOpenSettings} className="h-9 gap-1.5">
          <Settings className="size-4" />
          {t("common.settings")}
        </Button>
        {/* Logs — discreet, for debugging; a dot signals errors. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleLogs}
          aria-label={errorLogCount > 0 ? t("header.logsWithErrors", { count: errorLogCount }) : t("common.logs")}
          title={errorLogCount > 0 ? t("header.errors", { count: errorLogCount }) : t("common.logs")}
          className="text-muted-foreground/60 hover:text-foreground relative size-9"
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

// LanguageToggle — cycles through SUPPORTED_LANGUAGES from the header. It sets
// an explicit (persisted) choice, exactly like picking a language in Settings;
// "follow the system" remains available there.
function LanguageToggle() {
  const { i18n } = useTranslation();
  const idx = SUPPORTED_LANGUAGES.findIndex((l) => l.code === i18n.language);
  const current = SUPPORTED_LANGUAGES[idx] ?? SUPPORTED_LANGUAGES[0];
  const next = SUPPORTED_LANGUAGES[(Math.max(idx, 0) + 1) % SUPPORTED_LANGUAGES.length];
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setLanguage(next.code)}
      // The next language names itself (中文 reads it in Chinese, English in
      // English), so the tooltip stays readable before AND after switching.
      title={next.label}
      aria-label={next.label}
      className="text-muted-foreground hover:text-foreground h-9 gap-1.5"
    >
      <Languages className="size-4" />
      <span className="text-xs font-medium">{current.short}</span>
    </Button>
  );
}

// ThemeToggle — cycles the appearance System → Light → Dark from the header.
// The choice is persisted (localStorage); "System" follows the OS live. The
// icon shows the ACTIVE preference and the tooltip names what a click switches
// TO, so the control reads correctly before and after pressing it.
const THEME_CYCLE: ThemePref[] = ["system", "light", "dark"];
function ThemeToggle() {
  const { t } = useTranslation();
  const pref = useSyncExternalStore(subscribeTheme, themePref, () => "system" as ThemePref);
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length];
  const Icon = pref === "system" ? Monitor : pref === "light" ? Sun : Moon;
  const nextLabel = t(`theme.${next}`);
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setThemePref(next)}
      title={t("theme.switchTo", { mode: nextLabel })}
      aria-label={t("theme.current", { mode: t(`theme.${pref}`) })}
      className="text-muted-foreground hover:text-foreground size-9"
    >
      <Icon className="size-4" />
    </Button>
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
  const { t } = useTranslation();
  // A shared floor width + centering so the pill keeps a stable footprint as the
  // engine moves through install → select → start → running (the left header
  // cluster no longer shifts on every state change).
  const pill =
    "inline-flex min-w-[7.5rem] items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-[color,background-color,border-color] disabled:cursor-not-allowed disabled:opacity-50";

  if (installing) {
    return (
      <span className={cn(pill, "border-border text-muted-foreground")}>
        <Loader2 className="size-3 animate-spin" /> {t("engineControl.installing")}
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
        <Download className="size-3" /> {t("engineControl.install")}
      </button>
    );
  }
  if (status.state === "starting") {
    return (
      <span className={cn(pill, "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
        <Loader2 className="size-3 animate-spin" /> {t("engineControl.starting")}
      </span>
    );
  }
  if (status.state === "ready") {
    return (
      <button
        type="button"
        onClick={onStop}
        title={t("engineControl.runningTitle", { device: status.device })}
        className={cn(
          pill,
          "group border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600 dark:text-emerald-300"
        )}
      >
        <span className="size-1.5 rounded-full bg-emerald-500 group-hover:hidden" />
        <Square className="hidden size-3 group-hover:inline" />
        <span className="group-hover:hidden">{t("engineControl.on")}</span>
        <span className="hidden group-hover:inline">{t("engineControl.stop")}</span>
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
        title={t("engineControl.selectModelTitle")}
        className={cn(pill, "border-border text-muted-foreground hover:text-foreground hover:border-primary/40")}
      >
        <Cpu className="size-3" /> {t("engineControl.selectModel")}
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
      title={errMsg || t("engineControl.startTitle")}
      className={cn(
        pill,
        isError
          ? "border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
          : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
      )}
    >
      <Play className="size-3" />
      {isError ? t("engineControl.restart") : t("engineControl.start")}
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
  const { t } = useTranslation();
  // ⌘/Ctrl+Enter is handled globally in App (works from anywhere, not just this
  // field), so the textarea needs no key handler of its own.

  return (
    <div className="composer bg-card rounded-2xl border">
      {/* Pre-prompt (quality tags) — secondary: small, dim, tucked at the top. */}
      {showModelFields && (
        <label className="hover:bg-muted/30 focus-within:bg-muted/30 block rounded-t-2xl px-5 pb-2 pt-2.5 transition-colors">
          <span className="text-muted-foreground/70 text-[11px] font-medium uppercase tracking-wide">
            {t("composer.qualityTags")}
          </span>
          <textarea
            value={prePrompt}
            onChange={(e) => onPrePromptChange(e.target.value)}
            placeholder={t("composer.qualityTagsPlaceholder")}
            rows={1}
            className="placeholder:text-muted-foreground/40 text-muted-foreground/90 block max-h-20 w-full resize-none border-0 bg-transparent text-xs leading-snug outline-none"
          />
        </label>
      )}

      {/* Prompt — the hero: largest text, most room, clear separation. */}
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder={t("composer.promptPlaceholder")}
        rows={3}
        className={cn(
          "placeholder:text-muted-foreground/60 border-border/60 focus:bg-muted/15 block max-h-72 min-h-32 w-full resize-none border-0 bg-transparent px-5 py-4 text-base font-medium leading-relaxed outline-none transition-colors",
          showModelFields ? "border-y" : "rounded-t-2xl"
        )}
      />

      {/* Negative prompt — secondary, mirrors the pre-prompt styling. */}
      {showModelFields && (
        <label className="hover:bg-muted/30 focus-within:bg-muted/30 block px-5 pb-2.5 pt-2 transition-colors">
          <span className="text-muted-foreground/70 text-[11px] font-medium uppercase tracking-wide">
            {t("composer.negativePrompt")}
          </span>
          <textarea
            value={negativePrompt}
            onChange={(e) => onNegativePromptChange(e.target.value)}
            placeholder={t("composer.negativePlaceholder")}
            rows={1}
            className="placeholder:text-muted-foreground/40 text-muted-foreground/90 block max-h-20 w-full resize-none border-0 bg-transparent text-xs leading-snug outline-none"
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
      <div className="flex items-end justify-between gap-3 px-5 pt-2 pb-4">
        <span className="text-muted-foreground/80 min-w-0 truncate text-[11px]" title={contextHint}>
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

// FormatSelector — the image aspect (square / portrait / landscape …), pulled
// out of the collapsible Parameters so it's always one tap away, right under the
// prompt. Options and per-model dimensions come from the catalog (im_format),
// falling back to the generic set. In local mode a "Custom" option unlocks free
// width/height (the sidecar takes arbitrary dims; the cloud API doesn't).
function FormatSelector({
  model,
  mode,
  params,
  onChange,
}: {
  model: ModelInfo;
  mode: Mode;
  params: GenParams;
  onChange: (patch: Partial<GenParams>) => void;
}) {
  const { t } = useTranslation();
  const formats = formatOptions(model);
  const allowCustom = mode === "local";
  const isCustom = params.formatCode === CUSTOM_FORMAT;
  if (formats.length <= 1 && !allowCustom) return null; // nothing to choose

  // Entering custom seeds the free dims from the preset currently in view.
  const enterCustom = () => {
    if (isCustom) return;
    const d = dimsForModel(model, params.formatCode);
    onChange({ formatCode: CUSTOM_FORMAT, customWidth: d.width, customHeight: d.height });
  };

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      {/* Label on its own line + a wrapping segmented control, so 4 options (with
          ratio hints) never overflow the narrow panel — they flow to a 2nd row. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {t("params.format")}
        </span>
        <Segmented
          wrap
          size="sm"
          value={isCustom ? CUSTOM_FORMAT : params.formatCode}
          onChange={(code) => (code === CUSTOM_FORMAT ? enterCustom() : onChange({ formatCode: code }))}
          items={[
            ...formats.map((f) => ({
              value: f.formatCode,
              title: `${f.width}×${f.height}${f.ratio ? ` · ${f.ratio}` : ""}`,
              label: (
                <span className="capitalize">
                  {formatName(f, t)}
                  {f.ratio && (
                    <span className="text-muted-foreground/70 ml-1 text-[10px] normal-case">{f.ratio}</span>
                  )}
                </span>
              ),
            })),
            ...(allowCustom ? [{ value: CUSTOM_FORMAT, label: t("formats.custom") }] : []),
          ]}
        />
      </div>

      {/* Free width × height (local, custom only). Snap to a multiple of 8 on
          blur; the value is re-snapped at generation regardless. */}
      {isCustom && (
        <div className="mt-2.5 flex items-center gap-2">
          <DimInput
            label={t("params.width")}
            value={params.customWidth}
            onChange={(customWidth) => onChange({ customWidth })}
            onCommit={(customWidth) => onChange({ customWidth: snapDim(customWidth) })}
          />
          <span className="text-muted-foreground/60 mt-4 shrink-0 text-xs">×</span>
          <DimInput
            label={t("params.height")}
            value={params.customHeight}
            onChange={(customHeight) => onChange({ customHeight })}
            onCommit={(customHeight) => onChange({ customHeight: snapDim(customHeight) })}
          />
        </div>
      )}
    </section>
  );
}

// A single labelled width/height number input for the custom format. Typing sets
// the raw value (so you can type freely); blur/Enter snaps it to a valid dim.
function DimInput({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">{label}</span>
      <input
        type="number"
        min={256}
        max={2048}
        step={8}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        onBlur={(e) => onCommit(Number(e.target.value) || 512)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="border-input bg-background field-focus h-8 w-full rounded-md border px-2 text-xs tabular-nums"
      />
    </label>
  );
}

// ParamsPanel — collapsible generation parameters, seeded from the model's
// catalog defaults (steps/cfg bounds, negative prompt) and tweakable per
// generation. Format now lives in its own always-visible FormatSelector above
// the prompt. Clip-skip / scheduler are local-only (the cloud API uses the
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<GenParams>) => onChange({ ...params, ...patch });

  const stepsMin = model.stepsMin || 1;
  const stepsMax = Math.max(model.stepsMax || 50, stepsMin + 1);
  const cfgMin = model.cfgMin || 1;
  const cfgMax = Math.max(model.cfgMax || 20, cfgMin + 0.5);
  const showClip = model.skipDefault > 0; // model uses clip-skip
  const dims = resolveDims(model, params);
  const summary = t("params.summary", {
    dims: `${dims.width}×${dims.height}`,
    steps: params.steps,
    cfg: params.cfg,
  });

  return (
    <section className="bg-card rounded-2xl border shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontal className="text-muted-foreground size-4 shrink-0" />
          <span className="text-sm font-semibold">{t("params.title")}</span>
          <span className="text-muted-foreground/80 truncate text-[11px]">{summary}</span>
        </div>
        <ChevronDown
          className={cn("text-muted-foreground size-4 shrink-0 transition", open && "rotate-180")}
        />
      </button>

      {/* Animate open/close via a grid-rows 0fr→1fr collapse (auto-height, no JS
          measuring) so the body eases in to match the chevron rotation. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[var(--ease-out-expo)]",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="grid gap-4 border-t px-4 py-4">
            <RangeRow label={t("params.steps")} value={params.steps} min={stepsMin} max={stepsMax} step={1} onChange={(v) => set({ steps: v })} />
            <RangeRow label={t("params.cfg")} value={params.cfg} min={cfgMin} max={cfgMax} step={0.5} onChange={(v) => set({ cfg: v })} />

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{t("params.seed")}</span>
                <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-[11px]">
                  <Checkbox
                    checked={params.seedMode === "random"}
                    onCheckedChange={(c) => set({ seedMode: c ? "random" : "fixed" })}
                  />
                  {t("params.random")}
                </label>
              </div>
              {params.seedMode === "fixed" && (
                <input
                  type="number"
                  value={params.seed}
                  onChange={(e) => set({ seed: Number(e.target.value) || 0 })}
                  className="border-input bg-background field-focus h-8 rounded-md border px-2 text-xs tabular-nums"
                />
              )}
            </div>

            {mode === "local" && (
              <div className="grid gap-3 border-t pt-3">
                <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                  {t("params.advanced")}
                </span>
                {showClip && (
                  <RangeRow
                    label={t("params.clipSkip")}
                    value={params.clipSkip ?? model.skipDefault}
                    min={0}
                    max={4}
                    step={1}
                    onChange={(v) => set({ clipSkip: v })}
                  />
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{t("params.scheduler")}</span>
                  {/* Informational (no scheduler list yet) — a value chip, not a
                      disabled input, so it doesn't read as interactive. */}
                  <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-[11px] font-medium">
                    {params.scheduler || t("params.modelDefault")}
                  </span>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => onChange(defaultParams(model))}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 justify-self-start text-[11px]"
            >
              <RotateCcw className="size-3" /> {t("params.reset")}
            </button>
          </div>
        </div>
      </div>
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
        className="range w-full"
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
  const { t } = useTranslation();
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
    <div className="border-border/60 mx-5 mt-1 border-t pt-2">
      <input ref={inputRef} type="file" accept="image/*" onChange={onPick} className="hidden" />
      {sourceImage ? (
        <div className="flex items-center gap-3">
          <img
            src={sourceImage}
            alt={t("img2img.sourceAlt")}
            className="size-11 shrink-0 rounded-lg border object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-[11px]">
                {t("img2img.label", { strength: strength.toFixed(2) })}
              </span>
              <button
                type="button"
                onClick={() => onSourceImageChange(null)}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
              >
                <X className="size-3" /> {t("common.remove")}
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={strength}
              onChange={(e) => onStrengthChange(Number(e.target.value))}
              className="range w-full"
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[11px]"
        >
          <ImageIcon className="size-3.5" /> {t("img2img.add")}
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
  const { t } = useTranslation();
  return (
    <div className="bg-muted grid grid-cols-2 gap-1 rounded-2xl p-1 text-sm">
      <SegBtn
        active={mode === "local"}
        ready={localReady}
        tone="brand"
        onClick={() => onModeChange("local")}
        icon={<Cpu className="size-4" />}
        label={t("mode.local")}
      />
      <SegBtn
        active={mode === "cloud"}
        ready={cloudReady}
        tone="cloud"
        onClick={() => onModeChange("cloud")}
        icon={<Cloud className="size-4" />}
        label={t("mode.cloud")}
      />
    </div>
  );
}

function SegBtn({
  active,
  ready,
  tone,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  ready: boolean;
  tone: "brand" | "cloud";
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  const { t } = useTranslation();
  // Concentric radii: rounded-2xl track − p-1 gap = rounded-xl thumb.
  return (
    <button
      type="button"
      onClick={onClick}
      // Readiness is shown on BOTH tabs (so you can see the other mode is ready
      // before switching) but always labelled via the title; the active mode is
      // carried by the accent + surface, not the dot.
      title={`${label} · ${ready ? t("mode.ready") : t("mode.notReady")}`}
      className={cn(
        "relative inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 font-medium transition-[color,background-color,box-shadow] duration-200",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      <span
        className={cn(
          active && (tone === "brand" ? "text-[var(--brand-from)]" : "text-[var(--cloud-from)]")
        )}
      >
        {icon}
      </span>
      {label}
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full transition-colors",
          ready ? "bg-emerald-500" : "bg-muted-foreground/30",
          !active && "opacity-60"
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Gallery — this session's finished generations + the saved-image history, in
// an aspect-aware masonry (any format). Adjustable columns, infinite scroll
// over the saved history, click-to-fullscreen, and delete. In-flight jobs live
// in the Activity panel, not here.
// ---------------------------------------------------------------------------

const GALLERY_PAGE = 24;

const EMPTY_FILTER: GalleryFilter = { engine: "", modelCode: "", source: "", text: "" };

type LightboxItem = { src: string; meta?: GenerationMeta | null };

// One image in the gallery's viewable sequence — the unit the lightbox steps
// through and every action targets. `name` (a filename) keys delete/reveal; it's
// null for a session job not yet written to disk.
type ViewerItem = {
  name: string | null;
  savedPath?: string;
  meta?: GenerationMeta | null;
  getSrc: () => Promise<string>;
};

// What a tile hands to the context menu. Adds the tile's position in the viewer
// sequence so "Open" can jump straight there.
type TileTarget = ViewerItem & { index: number };

// Shared gallery behaviors handed to every tile (open, context menu, selection,
// drag). `index` is the tile's position in the viewer sequence.
type GalleryShared = {
  openAt: (index: number) => void;
  openMenu: (e: React.MouseEvent, target: TileTarget) => void;
  selectionActive: boolean;
  isSelected: (name: string) => boolean;
  tileClick: (e: React.MouseEvent, name: string | null, index: number) => void;
  toggle: (name: string | null, index: number) => void;
  startDrag: (e: React.DragEvent, name: string | null, src: string | null) => void;
};

// Basename of a saved path, for matching a session job to its file on disk.
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function Gallery({
  jobs,
  onUseAsSource,
  onReuseSettings,
  onHideJob,
}: {
  jobs: Job[];
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onHideJob: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<SavedImage[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cols, setCols] = useState(3);
  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_FILTER);
  const [facets, setFacets] = useState<GalleryFacets | null>(null);
  // Multi-selection (keyed by filename), the context menu, and the fullscreen
  // viewer (an index into the viewable sequence, or null when closed).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; target: TileTarget } | null>(null);
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const anchorRef = useRef<number | null>(null); // last-toggled index, for Shift-range
  const viewItemsRef = useRef<ViewerItem[]>([]); // the viewable sequence, in display order
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false); // guards against overlapping page loads
  const savedRef = useRef<SavedImage[]>([]);
  savedRef.current = saved;
  const jobsRef = useRef<Job[]>(jobs);
  jobsRef.current = jobs;
  // Disk-pagination offset, tracked separately from `saved.length` because we
  // also PREPEND freshly-generated images (below) — using saved.length as the
  // offset would then skip disk rows.
  const diskCountRef = useRef(0);
  // Session jobs already folded into `saved`, so we don't merge them twice.
  const mergedRef = useRef<Set<string>>(new Set());

  const refreshFacets = useCallback(() => {
    void api.galleryFacets().then(setFacets).catch(() => {});
  }, []);
  useEffect(refreshFacets, [refreshFacets]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    api
      .listSavedImages(diskCountRef.current, GALLERY_PAGE, filter)
      .then((page) => {
        diskCountRef.current += page.length;
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
    diskCountRef.current = 0;
    setSaved([]);
    setDone(false);
    loadingRef.current = false;
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Fold freshly-finished session generations into the gallery as real saved
  // images (the Activity panel already covers live progress, so the gallery no
  // longer shows transient session tiles). Prepended newest-first with their
  // in-memory bytes so they appear instantly; a later disk page dedupes them.
  useEffect(() => {
    const fresh: SavedImage[] = [];
    for (const j of jobs) {
      if (mergedRef.current.has(j.id)) continue;
      const img = j.image;
      if (!img?.savedPath) continue; // save failed → only visible in Activity
      mergedRef.current.add(j.id);
      const m = img.meta;
      fresh.push({
        name: baseName(img.savedPath),
        source: img.source,
        seed: img.seed ?? m?.seed ?? 0,
        savedPath: img.savedPath,
        width: m?.width ?? 0,
        height: m?.height ?? 0,
        meta: m,
        src: img.imageBase64,
      });
    }
    if (fresh.length) {
      setSaved((cur) => {
        const seen = new Set(cur.map((s) => s.name));
        const add = fresh.filter((s) => !seen.has(s.name)).reverse();
        return add.length ? [...add, ...cur] : cur;
      });
    }
  }, [jobs]);

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

  // Hide session job-tiles whose on-disk file was just deleted (so the deleted
  // image doesn't linger as a fresh tile).
  const hideJobsFor = useCallback(
    (names: Set<string>) => {
      for (const j of jobsRef.current) {
        const n = j.image?.savedPath ? baseName(j.image.savedPath) : null;
        if (n && names.has(n)) onHideJob(j.id);
      }
    },
    [onHideJob]
  );

  const deleteNames = useCallback(
    (names: string[]) => {
      if (names.length === 0) return;
      void Promise.allSettled(names.map((n) => api.deleteSavedImage(n))).then(() => {
        const set = new Set(names);
        setSaved((s) => s.filter((x) => !set.has(x.name)));
        setSelected((cur) => {
          const next = new Set(cur);
          names.forEach((n) => next.delete(n));
          return next;
        });
        hideJobsFor(set);
        refreshFacets();
      });
    },
    [hideJobsFor, refreshFacets]
  );

  const deleteOne = useCallback(
    (name: string) => {
      if (!window.confirm(t("gallery.deleteConfirm", { name }))) return;
      deleteNames([name]);
    },
    [deleteNames, t]
  );

  const deleteSelected = useCallback(() => {
    const names = [...selected];
    if (names.length === 0) return;
    if (!window.confirm(t("gallery.deleteSelectedConfirm", { count: names.length }))) return;
    deleteNames(names);
  }, [selected, deleteNames, t]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const openAt = useCallback((index: number) => {
    if (index >= 0) setViewIndex(index);
  }, []);

  // Toggle one tile's selection; remember it as the Shift-range anchor.
  const toggle = useCallback((name: string | null, index: number) => {
    if (!name) return;
    anchorRef.current = index;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Click on a tile: modifier-click selects (⌘/Ctrl toggles, Shift extends the
  // range from the anchor); a plain click opens the fullscreen viewer.
  const tileClick = useCallback(
    (e: React.MouseEvent, name: string | null, index: number) => {
      if ((e.metaKey || e.ctrlKey) && name) {
        toggle(name, index);
        return;
      }
      if (e.shiftKey && name && anchorRef.current != null) {
        const [lo, hi] = [Math.min(anchorRef.current, index), Math.max(anchorRef.current, index)];
        const range = viewItemsRef.current
          .slice(lo, hi + 1)
          .map((v) => v.name)
          .filter((n): n is string => !!n);
        setSelected((cur) => new Set([...cur, ...range]));
        return;
      }
      openAt(index);
    },
    [toggle, openAt]
  );

  const startDrag = useCallback((e: React.DragEvent, name: string | null, src: string | null) => {
    if (src) {
      e.dataTransfer.setData(DRAG_SRC, src);
      // Let the OS/other apps accept a drop as a real file (Chromium/Edge webviews).
      e.dataTransfer.setData("DownloadURL", `image/png:${name || "image.png"}:${src}`);
    }
    if (name) e.dataTransfer.setData(DRAG_NAME, name);
    e.dataTransfer.effectAllowed = "copyMove";
  }, []);

  const openMenu = useCallback((e: React.MouseEvent, target: TileTarget) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  // Latest values for the once-subscribed keyboard listener.
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;
  const viewIndexRef = useRef(viewIndex);
  viewIndexRef.current = viewIndex;
  const menuRef = useRef(menu);
  menuRef.current = menu;

  // Keyboard: ⌘/Ctrl+A selects all, Delete removes the selection, Escape clears
  // it. Ignored while typing in a field, or when a modal (viewer/menu) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        const names = viewItemsRef.current.map((v) => v.name).filter((n): n is string => !!n);
        if (names.length) {
          e.preventDefault();
          setSelected(new Set(names));
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        setSelected((cur) => {
          if (cur.size > 0) {
            e.preventDefault();
            deleteSelectedRef.current();
          }
          return cur;
        });
      } else if (e.key === "Escape" && viewIndexRef.current == null && !menuRef.current) {
        setSelected((cur) => (cur.size > 0 ? new Set() : cur));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the open viewer valid when the sequence shrinks (e.g. after a delete):
  // clamp to the last item, or close if nothing is left.
  useEffect(() => {
    const n = viewItemsRef.current.length;
    setViewIndex((vi) => (vi != null && vi >= n ? (n > 0 ? n - 1 : null) : vi));
  }, [saved.length, jobs.length]);

  const filtered =
    filter.engine !== "" || filter.modelCode !== "" || filter.source !== "" || filter.text !== "";

  const shared: GalleryShared = {
    openAt,
    openMenu,
    selectionActive: selected.size > 0,
    isSelected: (name) => selected.has(name),
    tileClick,
    toggle,
    startDrag,
  };

  // Build the tile list + the parallel viewer sequence (same order) whose index
  // every tile, the menu, and the lightbox share. Tiles are spread across `cols`
  // columns round-robin so the reading order is LEFT-TO-RIGHT; each column stacks
  // at natural height → true masonry. Session generations are folded into `saved`
  // (see the merge effect), so the gallery is a single uniform stream.
  const tiles: { key: string; el: React.ReactElement }[] = [];
  const viewItems: ViewerItem[] = [];
  const pushView = (v: ViewerItem) => {
    viewItems.push(v);
    return viewItems.length - 1;
  };
  for (const g of saved) {
    const index = pushView({
      name: g.name,
      savedPath: g.savedPath || undefined,
      meta: g.meta,
      getSrc: () => (g.src ? Promise.resolve(g.src) : api.getSavedImage(g.name)),
    });
    tiles.push({ key: g.name, el: <SavedTile image={g} index={index} shared={shared} onDelete={deleteOne} /> });
  }
  viewItemsRef.current = viewItems;
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
            {filtered ? t("gallery.emptyFiltered") : t("gallery.empty")}
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

      {/* Floating selection bar. */}
      {selected.size > 0 && (
        <div className="animate-in fade-in slide-in-from-bottom-2 fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-popover/95 px-2 py-2 pl-4 shadow-2xl backdrop-blur">
          <span className="text-sm font-medium tabular-nums">
            {t("gallery.selectedCount", { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={deleteSelected}
            className="text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <Trash2 className="size-3.5" /> {t("gallery.deleteSelected")}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
          >
            {t("gallery.clearSelection")}
          </button>
        </div>
      )}

      {menu && (
        <TileContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          onClose={() => setMenu(null)}
          onOpenAt={openAt}
          onUseAsSource={onUseAsSource}
          onReuseSettings={onReuseSettings}
          onDelete={deleteOne}
        />
      )}

      {viewIndex != null && viewItems[viewIndex] && (
        <Lightbox
          items={viewItems}
          index={viewIndex}
          onIndex={setViewIndex}
          onClose={() => setViewIndex(null)}
          onUseAsSource={onUseAsSource}
          onReuseSettings={onReuseSettings}
          onDelete={deleteOne}
        />
      )}
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
  const { t } = useTranslation();
  const active =
    filter.engine !== "" || filter.modelCode !== "" || filter.source !== "" || filter.text !== "";
  // Guard against nil slices (Go marshals empty slices as null).
  const models = facets?.models ?? [];
  const engines = facets?.engines ?? [];
  const sources = facets?.sources ?? [];

  // Debounce the search box so typing doesn't reload the gallery per keystroke.
  const [q, setQ] = useState(filter.text);
  useEffect(() => setQ(filter.text), [filter.text]); // stay in sync on external Clear
  const commitRef = useRef<(text: string) => void>(() => {});
  commitRef.current = (text: string) => onChange({ ...filter, text });
  useEffect(() => {
    if (q === filter.text) return;
    const id = setTimeout(() => commitRef.current(q), 250);
    return () => clearTimeout(id);
  }, [q, filter.text]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="text-muted-foreground/60 pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("gallery.search")}
          aria-label={t("gallery.search")}
          className="border-input bg-background h-8 w-44 rounded-md border pl-8 pr-2 text-xs outline-none"
        />
      </div>
      {models.length > 0 && (
        <FacetSelect
          label={t("gallery.filterModel")}
          value={filter.modelCode}
          facets={models}
          onChange={(v) => onChange({ ...filter, modelCode: v })}
        />
      )}
      {engines.length > 1 && (
        <FacetSelect
          label={t("gallery.filterEngine")}
          value={filter.engine}
          facets={engines}
          onChange={(v) => onChange({ ...filter, engine: v })}
        />
      )}
      {sources.length > 1 && (
        <FacetSelect
          label={t("gallery.filterSource")}
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
          {t("common.clear")}
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
  const { t } = useTranslation();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-input bg-background h-8 max-w-40 rounded-md border px-2 text-xs"
      aria-label={label}
    >
      <option value="">{t("gallery.filterAll", { label })}</option>
      {facets.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label} ({f.count})
        </option>
      ))}
    </select>
  );
}

function ColumnPicker({ cols, onChange }: { cols: number; onChange: (n: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-muted inline-flex items-center gap-0.5 rounded-lg p-0.5" role="group" aria-label={t("gallery.columns")}>
      {[1, 2, 3, 4].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-label={t("gallery.columns", { count: n })}
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

// A small selection checkbox overlaid on a tile — visible on hover or whenever a
// selection is in progress.
function SelectCheckbox({
  checked,
  active,
  onToggle,
}: {
  checked: boolean;
  active: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
      aria-label={t("gallery.select")}
      aria-pressed={checked}
      className={cn(
        "absolute left-1.5 top-1.5 z-10 flex size-5 items-center justify-center rounded-md border-2 shadow-sm transition",
        checked
          ? "border-[var(--brand-to)] bg-[var(--brand-to)] text-white"
          : "border-white/85 bg-black/35 text-transparent hover:bg-black/50",
        active || checked ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
  );
}

// A saved image from the output folder. Bytes are fetched lazily (base64 over the
// Wails bridge) only when the tile scrolls into view; its aspect box is reserved
// from the known dimensions so the masonry lays out any format without jumps.
function SavedTile({
  image,
  index,
  shared,
  onDelete,
}: {
  image: SavedImage;
  index: number;
  shared: GalleryShared;
  onDelete: (name: string) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  // Freshly-merged images carry their bytes in memory (image.src) → render at
  // once, no disk read; folder images fetch lazily on scroll-in.
  const [src, setSrc] = useState<string | null>(image.src ?? null);
  const srcRef = useRef<string | null>(src);
  srcRef.current = src;

  useEffect(() => {
    if (srcRef.current) return; // already have the bytes (fresh image)
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
  const selected = shared.isSelected(image.name);

  // Ensure the bytes are available (img2img / drag from an un-scrolled tile).
  const ensureSrc = () => (srcRef.current ? Promise.resolve(srcRef.current) : api.getSavedImage(image.name).then((d) => { setSrc(d); return d; }));

  return (
    <figure
      ref={ref}
      draggable
      onDragStart={(e) => shared.startDrag(e, image.name, srcRef.current)}
      className={cn(
        "group bg-muted/40 relative cursor-zoom-in overflow-hidden rounded-2xl ring-1",
        selected ? "ring-2 ring-[var(--brand-to)]" : "ring-border/60"
      )}
      title={image.name}
      style={{ aspectRatio: aspect }}
      onClick={(e) => shared.tileClick(e, image.name, index)}
      onContextMenu={(e) =>
        shared.openMenu(e, {
          index,
          name: image.name,
          savedPath: image.savedPath || undefined,
          meta: image.meta,
          getSrc: ensureSrc,
        })
      }
    >
      {src ? (
        <img src={src} alt={image.name} className="animate-in fade-in h-full w-full object-cover duration-300" />
      ) : (
        <div className="text-muted-foreground/30 flex h-full w-full items-center justify-center">
          <ImageIcon className="size-5" />
        </div>
      )}
      <SelectCheckbox
        checked={selected}
        active={shared.selectionActive}
        onToggle={() => shared.toggle(image.name, index)}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(image.name);
        }}
        aria-label={t("gallery.deleteImage")}
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
        {image.seed > 0 && <span className="tabular-nums">{t("gallery.seed", { seed: image.seed })}</span>}
      </figcaption>
    </figure>
  );
}

// TileContextMenu — a small right-click menu positioned at the cursor. A
// full-screen backdrop captures the next click (and Escape) to dismiss.
function TileContextMenu({
  x,
  y,
  target,
  onClose,
  onOpenAt,
  onUseAsSource,
  onReuseSettings,
  onDelete,
}: {
  x: number;
  y: number;
  target: TileTarget;
  onClose: () => void;
  onOpenAt: (index: number) => void;
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onDelete: (name: string) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clamp so the menu stays on screen (approx sizes; good enough without measuring).
  const W = 232;
  const H = 300;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);
  const meta = target.meta;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="animate-in fade-in zoom-in-95 bg-popover absolute overflow-hidden rounded-xl border p-1 shadow-2xl duration-100"
        style={{ left, top, width: W }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        <MenuItem
          icon={<Maximize2 />}
          label={t("gallery.ctxOpen")}
          onClick={run(() => onOpenAt(target.index))}
        />
        <MenuItem
          icon={<ImageIcon />}
          label={t("gallery.ctxUseAsSource")}
          onClick={run(() => onUseAsSource(target.getSrc))}
        />
        {meta?.prompt && (
          <MenuItem
            icon={<RotateCcw />}
            label={t("gallery.ctxReuse")}
            onClick={run(() => onReuseSettings(meta))}
          />
        )}
        {meta?.prompt && (
          <MenuItem
            icon={<Copy />}
            label={t("gallery.ctxCopyPrompt")}
            onClick={run(() => void navigator.clipboard?.writeText(meta.prompt).catch(() => {}))}
          />
        )}
        {target.savedPath && (
          <MenuItem
            icon={<FolderOpen />}
            label={t("gallery.ctxReveal")}
            onClick={run(() => void api.revealInFolder(target.savedPath!).catch(() => {}))}
          />
        )}
        {target.name && (
          <>
            <div className="bg-border/70 my-1 h-px" />
            <MenuItem
              icon={<Trash2 />}
              label={t("gallery.ctxDelete")}
              destructive
              onClick={run(() => onDelete(target.name!))}
            />
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors [&_svg]:size-4",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-accent"
      )}
    >
      <span className={cn("shrink-0", destructive ? "" : "text-muted-foreground")}>{icon}</span>
      {label}
    </button>
  );
}

// Fullscreen viewer over the gallery's viewable sequence: ←/→ (and edge arrows)
// navigate, and the same actions as the right-click menu act on the current
// image. Backdrop click or Esc closes.
function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  onUseAsSource,
  onReuseSettings,
  onDelete,
}: {
  items: ViewerItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onDelete: (name: string) => void;
}) {
  const { t } = useTranslation();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const total = items.length;
  const current = items[index];
  const hasPrev = index > 0;
  const hasNext = index < total - 1;
  const prev = useCallback(() => onIndex(Math.max(0, index - 1)), [index, onIndex]);
  const next = useCallback(() => onIndex(Math.min(total - 1, index + 1)), [index, total, onIndex]);

  // Fetch the current image's bytes on navigation (and after a delete shifts the
  // sequence, keyed by length).
  useEffect(() => {
    const cur = itemsRef.current[index];
    if (!cur) return;
    let alive = true;
    setLoading(true);
    setSrc(null);
    void cur
      .getSrc()
      .then((d) => alive && (setSrc(d), setLoading(false)))
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [index, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  if (!current) return null;
  const meta = current.meta;

  const iconBtn =
    "rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10";

  return (
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Top bar: counter + actions + close. */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium tabular-nums text-white">
          {t("gallery.counter", { i: index + 1, n: total })}
        </span>
        <div className="flex items-center gap-1.5">
          <button type="button" className={iconBtn} title={t("gallery.ctxUseAsSource")} aria-label={t("gallery.ctxUseAsSource")} onClick={() => onUseAsSource(current.getSrc)}>
            <ImageIcon className="size-5" />
          </button>
          {meta?.prompt && (
            <button type="button" className={iconBtn} title={t("gallery.ctxReuse")} aria-label={t("gallery.ctxReuse")} onClick={() => onReuseSettings(meta)}>
              <RotateCcw className="size-5" />
            </button>
          )}
          {meta?.prompt && (
            <button type="button" className={iconBtn} title={t("gallery.ctxCopyPrompt")} aria-label={t("gallery.ctxCopyPrompt")} onClick={() => void navigator.clipboard?.writeText(meta.prompt).catch(() => {})}>
              <Copy className="size-5" />
            </button>
          )}
          {current.savedPath && (
            <button type="button" className={iconBtn} title={t("gallery.ctxReveal")} aria-label={t("gallery.ctxReveal")} onClick={() => void api.revealInFolder(current.savedPath!).catch(() => {})}>
              <FolderOpen className="size-5" />
            </button>
          )}
          {current.name && (
            <button type="button" className={cn(iconBtn, "hover:bg-red-600/70")} title={t("gallery.ctxDelete")} aria-label={t("gallery.ctxDelete")} onClick={() => onDelete(current.name!)}>
              <Trash2 className="size-5" />
            </button>
          )}
          <button type="button" className={iconBtn} title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
            <X className="size-5" />
          </button>
        </div>
      </div>

      {/* Prev / next edge arrows. */}
      {hasPrev && (
        <button type="button" className={cn(iconBtn, "absolute left-4 top-1/2 z-10 -translate-y-1/2")} aria-label={t("gallery.prev")} onClick={(e) => { e.stopPropagation(); prev(); }}>
          <ChevronLeft className="size-6" />
        </button>
      )}
      {hasNext && (
        <button type="button" className={cn(iconBtn, "absolute right-4 top-1/2 z-10 -translate-y-1/2")} aria-label={t("gallery.next")} onClick={(e) => { e.stopPropagation(); next(); }}>
          <ChevronRight className="size-6" />
        </button>
      )}

      <div
        className="flex max-h-full w-full max-w-6xl flex-col items-center gap-4 md:flex-row md:items-stretch"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {loading && <Loader2 className="absolute size-8 animate-spin text-white/70" />}
          {src && (
            <img
              src={src}
              alt=""
              className="animate-in fade-in max-h-[85vh] min-h-0 rounded-xl object-contain shadow-2xl duration-200"
            />
          )}
        </div>
        {meta && <MetaPanel meta={meta} />}
      </div>
    </div>
  );
}

function MetaPanel({ meta }: { meta: GenerationMeta }) {
  const { t } = useTranslation();
  const rows: [string, string][] = [];
  const add = (k: string, v: string | number | undefined | null) => {
    if (v !== undefined && v !== null && v !== "" && v !== 0) rows.push([k, String(v)]);
  };
  add(t("meta.model"), meta.modelName || meta.modelCode);
  add(t("meta.engine"), meta.engine);
  add(t("meta.source"), meta.source);
  add(t("meta.size"), meta.width && meta.height ? `${meta.width}×${meta.height}` : "");
  add(t("meta.format"), meta.formatCode);
  add(t("meta.steps"), meta.numSteps);
  add(t("meta.cfg"), meta.guidanceScale);
  add(t("meta.scheduler"), meta.scheduler);
  add(t("meta.clipSkip"), meta.clipSkip);
  add(t("meta.seed"), meta.seed);
  if (meta.img2img) add(t("meta.img2img"), t("meta.strength", { strength: meta.strength ?? "" }));
  add(t("meta.created"), meta.createdAt ? meta.createdAt.replace("T", " ").slice(0, 19) : "");

  return (
    <div className="bg-background/95 flex w-full shrink-0 flex-col gap-3 overflow-y-auto rounded-xl p-4 text-sm shadow-2xl md:max-h-[85vh] md:w-80">
      {meta.prompt && (
        <div>
          <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">{t("meta.prompt")}</div>
          <p className="leading-relaxed">{meta.prompt}</p>
        </div>
      )}
      {meta.negativePrompt && (
        <div>
          <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">{t("meta.negative")}</div>
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
  const { t } = useTranslation();
  const url = info.url ?? "https://github.com/Publikey/imference-desktop/releases/latest";
  return (
    <div className="animate-in fade-in slide-in-from-top-1 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300">
      <Download className="size-4 shrink-0" />
      <p className="flex-1 leading-relaxed">
        {/* Split around the bolded version so both word orders (en/zh) work. */}
        {t("update.availablePrefix")} <span className="font-semibold">v{info.latestVersion}</span>
        {t("update.availableSuffix")}
        {info.currentVersion !== "dev" && (
          <span className="opacity-70">{t("update.youHave", { version: info.currentVersion })}</span>
        )}
      </p>
      <Button
        size="sm"
        className="h-7 shrink-0 rounded-lg bg-amber-500 px-3 text-xs font-semibold text-white hover:bg-amber-400"
        onClick={() => void Browser.OpenURL(url)}
      >
        {t("common.download")}
      </Button>
      <button
        onClick={onDismiss}
        className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
        aria-label={t("common.dismiss")}
        title={t("update.dismissTitle")}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="border-destructive/25 bg-destructive/5 text-destructive animate-in fade-in slide-in-from-top-1 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1 leading-relaxed">{message}</p>
      <button
        onClick={onDismiss}
        className="hover:text-destructive/70 shrink-0 text-xs font-medium"
        aria-label={t("common.dismiss")}
      >
        {t("common.dismiss")}
      </button>
    </div>
  );
}
