import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Settings,
  Cloud,
  Cpu,
  Loader2,
  ScrollText,
  Keyboard,
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
  Minimize2,
  ChevronLeft,
  ChevronRight,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CustomModelDialog } from "@/components/CustomModelDialog";
import { ModelBar } from "@/components/ModelBar";
import { PaymentBar } from "@/components/PaymentBar";
import { LocalEngineSection } from "@/components/LocalEngineSection";
import { LogPanel } from "@/components/LogPanel";
import { PanelBoard, usePanelLayout } from "@/components/PanelBoard";
import { ActivityDock } from "@/components/ActivityDock";
import { CommandPalette, modLabel, type Command } from "@/components/CommandPalette";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { api } from "@/lib/wails-bridge";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { subscribeTheme, themePref, setThemePref, type ThemePref } from "@/lib/theme";
import logoUrl from "./assets/logo.svg";
import { installLogCapture } from "@/lib/log-capture";
import { beginPointerDrag } from "@/lib/pointer-drag";
import { prepareRefImage } from "@/lib/image";
import { cn, creditsToUSD } from "@/lib/utils";
import type {
  AppSettings,
  CloudResolved,
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

// WAN video generates at 480p video resolutions, NOT 1024² — a 1024² default is
// both wrong and far too heavy. Used only when the catalog carries no im_format
// rows for the WAN model; real catalog formats (when present) still win.
const VIDEO_FALLBACK_FORMATS: FormatOption[] = [
  { formatCode: "landscape", name: "", width: 832, height: 480, ratio: "16:9", isDefault: true },
  { formatCode: "portrait", name: "", width: 480, height: 832, ratio: "9:16", isDefault: false },
];

// The WAN video backend (normalizeEngine maps im_engine "wan22"/"wan" → "wan").
function isVideoModel(model: ModelInfo | null | undefined): boolean {
  return model?.backendType === "wan";
}

// Display name of a format: known codes are translated, otherwise the catalog
// name (server-provided) then the raw code.
function formatName(f: FormatOption, t: TFunction): string {
  return t(`formats.${f.formatCode}`, { defaultValue: f.name || f.formatCode });
}

// The catalog (im_format) ships some ratio strings the wrong way round — a
// 896×1152 portrait is tagged "9:7". Trust the dimensions and flip the string
// when its orientation disagrees; a fixed catalog row is then a no-op.
function formatRatio(f: FormatOption): string {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(f.ratio ?? "");
  if (!m || !f.width || !f.height) return f.ratio ?? "";
  const [a, b] = [Number(m[1]), Number(m[2])];
  const flipped = a > b !== f.width > f.height;
  return flipped ? `${b}:${a}` : `${a}:${b}`;
}

// A model's supported formats come from im_format; fall back to generic ones
// (video-specific for WAN, so a catalog missing its rows still defaults to 480p).
function formatOptions(model: ModelInfo | null | undefined): FormatOption[] {
  if (model?.formats && model.formats.length > 0) return model.formats;
  return isVideoModel(model) ? VIDEO_FALLBACK_FORMATS : FALLBACK_FORMATS;
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

// True for a video payload — a data:video/... URL (in-memory or fetched bytes).
// Gallery rows also carry kind === "video" from the Go side; both signals are
// checked at render sites since fresh in-memory items may predate the kind.
function isVideoSrc(src: string | null | undefined): boolean {
  return !!src && src.startsWith("data:video/");
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

// In-app drags (gallery tile → Create panel for img2img) use POINTER events, not
// native HTML5 drag — WebKit/WKWebView (the macOS app's engine) doesn't fire
// drop/dragend reliably for in-page drags. The native path below handles only
// OS file drops (dragging an image file in from Finder), where "Files" is always
// exposed. See lib/pointer-drag.ts and startImageDrag.

// Set true for the moment after a pointer image-drag ends, so the click that may
// follow pointerup doesn't also open the lightbox / toggle selection.
let suppressTileClick = false;

// True when a native (OS-originated) drag carries an image file we can drop.
function dragHasImage(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes("Files");
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
  const toast = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: "idle" });
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("local");
  // All generations, newest first. Running ones show a live placeholder; done
  // ones stay as images in the grid.
  const [jobs, setJobs] = useState<Job[]>([]);
  // The local engine is single-resident and runs one image at a time, so a model
  // switch must wait for the local queue to drain — restarting the sidecar mid-
  // denoise crashes the in-flight generation. "Active" = something local is
  // running or still queued (drives the "Add to queue" label).
  const localQueueActive = jobs.some(
    (j) => j.mode === "local" && !j.hidden && (j.status === "running" || j.status === "queued")
  );
  // The model the engine actually has loaded — the queue is per-model, since a
  // job may be enqueued for a cached model that isn't loaded yet.
  const loadedLocalCode = settings?.localModel?.modelCode ?? null;
  // Only jobs bound to the LOADED model block a switch: jobs queued for the
  // incoming model are exactly what the switch unblocks, so counting them would
  // deadlock (switch waits for the queue, queue waits for the switch). A ref
  // mirrors it so the switch handlers (defined above the jobs-derived value) can
  // read the latest state without re-binding.
  const localQueueBlocking = jobs.some(
    (j) =>
      j.mode === "local" &&
      !j.hidden &&
      (j.status === "running" || j.status === "queued") &&
      (!j.modelCode || j.modelCode === loadedLocalCode)
  );
  const localQueueActiveRef = useRef(localQueueBlocking);
  localQueueActiveRef.current = localQueueBlocking;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // When set, the Settings dialog scrolls to this section on open (deep-links
  // from the payment bar: "apikey" / "x402").
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [logsOpen, setLogsOpen] = useState(false);
  const [errorLogCount, setErrorLogCount] = useState(0);
  // Reference images (data-URLs) by slot, and their denoising strength. Always
  // OPTIONAL: empty → plain text2img. Slot 0 is the img2img source (or a video's
  // first frame), slot 1 a video's last frame. How many slots the form offers
  // comes from the selected model's refImages.
  const [refImages, setRefImages] = useState<(string | null)[]>([]);
  const [strength, setStrength] = useState(0.6);
  const sourceImage = refImages[0] ?? null;
  const setSourceImage = useCallback(
    (v: string | null) => setRefImages((prev) => [v, ...prev.slice(1)]),
    []
  );
  // Clean "not installed" state instead of a scary "Local error". Assume true
  // initially to avoid a flash before the first probe resolves.
  const [engineInstalled, setEngineInstalled] = useState(true);
  const [installing, setInstalling] = useState(false);
  // First-run onboarding is skippable; the choice persists so a deliberate skip
  // isn't undone on reload.
  const [onboardingSkipped, setOnboardingSkipped] = useState(
    () => localStorage.getItem("imference.onboarding.skipped") === "1"
  );
  const skipOnboarding = useCallback(() => {
    localStorage.setItem("imference.onboarding.skipped", "1");
    setOnboardingSkipped(true);
  }, []);
  // Tweakable generation params, seeded from the active model's defaults.
  const [params, setParams] = useState<GenParams | null>(null);
  // Local model selection is decoupled from its (heavy) download: picking a model
  // in the bar sets it pending; the primary button downloads it on demand, and
  // becomes "Generate" once the weights are on disk and the engine is ready.
  const [pendingLocalModel, setPendingLocalModel] = useState<ModelInfo | null>(null);
  // A model switch requested while the local queue is active is held here and
  // applied (its `apply` thunk fired) once the queue drains — see the effect
  // below. `label` names the incoming model for the "switch queued" banner.
  const [pendingSwitch, setPendingSwitch] = useState<{ label: string; apply: () => void } | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Whether the activation in flight is a cache hit (load only) rather than a
  // real download — same backend call, very different wait, so the button and
  // the hint say which one it is.
  const [activationIsLoad, setActivationIsLoad] = useState(false);
  const [dlProgress, setDlProgress] = useState<InstallProgress | null>(null);
  // Mirrors localCached (derived far below) so the activation handler, defined
  // before it, can tell a load from a download at click time.
  const localCachedRef = useRef(false);
  // Model codes whose weights are already on disk. Downloaded models are kept
  // (under a size quota), so this is what separates "needs a download" from
  // "just needs loading" — settings.localModel only knows the ACTIVE one.
  const [cachedCodes, setCachedCodes] = useState<Set<string>>(() => new Set());
  // Whether a usable x402 wallet exists (keychain — the real source of truth,
  // not settings.walletAddress). Drives cloud gating in x402 mode.
  const [walletConfigured, setWalletConfigured] = useState(false);
  // Panel arrangement (Create / Activity / Gallery) — drag-reorderable, persisted.
  const { columns: panelColumns, collapsed: panelCollapsed, widths: panelWidths, setColumns: setPanelColumns, toggleCollapsed: togglePanelCollapsed, setWidths: setPanelWidths } = usePanelLayout();
  // Fullscreen viewer — shared by the gallery and the Activity panel.
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);
  // Command palette (⌘K) + the model-picker open state it drives (lifted here so
  // the palette can open the picker, not just ModelBar's own trigger).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
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
    // Switching a custom checkpoint restarts the sidecar (it loads a different
    // .safetensors / backend), which activates the new engine.
    const doSwitch = async () => {
      const next = await api.useCustomModel(m.localPath!, m.backendType ?? "sdxl", m.baseModel ?? "");
      setSettings(next);
      setPendingLocalModel(next.localModel ?? null);
    };
    // Busy? Hold the switch until the local queue drains. The bar stays on the
    // loaded model (so params/metadata keep matching what actually runs); the
    // banner names the incoming one, and doSwitch swaps it over once it fires.
    if (localQueueActiveRef.current) {
      setPendingSwitch({ label: m.name, apply: () => void doSwitch().catch(() => {}) });
      toast.toast(t("toast.switchQueued", { name: m.name }));
      return;
    }
    // Immediate: await so ModelBar's try/catch can surface an activation error.
    await doSwitch();
  }, [toast, t]);

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
          if (p.phase === "done") toast.success(t("toast.engineInstalled"));
          else toast.error(p.error || t("toast.engineFailed"));
          void api.getEngineInfo().then((i) => setEngineInstalled(i.installed)).catch(() => {});
        } else {
          setInstalling(true);
        }
      }),
    [toast, t]
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

  // First run: nothing is usable yet (no local engine AND no cloud payment).
  // The Create panel shows a guided setup instead of the (non-functional)
  // composer, unless the user has skipped it.
  const firstRun = !engineInstalled && !cloudConfigured && !onboardingSkipped;

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
      // Cancelled: clear the progress UI entirely, no error styling.
      if (p.phase === "cancelled") {
        setDownloading(false);
        setDlProgress(null);
        toast.toast(t("toast.downloadCancelled"));
        return;
      }
      setDlProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error") {
        setDownloading(false);
        if (p.phase === "done") {
          toast.success(t("toast.modelReady"));
          void api.getSettings().then((s) => {
            setSettings(s);
            if (s.localModel) setPendingLocalModel(s.localModel);
          });
        } else if (p.phase === "error") {
          toast.error(p.error || t("toast.modelFailed"));
        }
      } else {
        setDownloading(true);
      }
    });
  }, [toast, t]);

  // Re-read which models are on disk. Also called on demand, not just from the
  // "model:cache" subscription below, when an activation discovers the index was
  // out of date.
  const refreshCachedModels = useCallback(() => {
    void api
      .listCachedModels()
      .then((list) => setCachedCodes(new Set(list.map((m) => m.modelCode).filter(Boolean) as string[])))
      .catch(() => {});
  }, []);

  // Make the pending pick the model the engine is running. `cachedOnly` is the
  // generate path: it must never start a download, so the Go side refuses (and
  // reports false) if the weights turn out not to be on disk after all — evicted
  // meanwhile, deleted by hand, or re-pointed by the catalog at new weights.
  const activateLocalModel = useCallback(
    (cachedOnly: boolean) => {
      if (!pendingLocalModel || downloading) return;
      const target = pendingLocalModel;
      const loadOnly = cachedOnly || localCachedRef.current;
      // Activation ends by restarting the sidecar onto the new weights, so it's
      // subject to the same "don't interrupt a running generation" rule as a swap.
      const apply = () => {
        setActivationIsLoad(loadOnly);
        setDownloading(true);
        setDlProgress({
          phase: "model",
          message: t("hint.preparing", { name: target.name }),
          percentEstimate: 0,
          done: false,
        });
        const call = cachedOnly
          ? api.ensureLocalModel(target.modelCode)
          : api.selectLocalModel(target.modelCode).then(() => true);
        void call
          .then((started) => {
            if (started) return;
            // Not cached after all: drop back to the explicit download. Refreshing
            // the cached set flips the button to "Download model" on its own.
            setDownloading(false);
            setDlProgress(null);
            refreshCachedModels();
            toast.error(t("toast.modelNotCached", { name: target.name }));
          })
          .catch((e) => {
            setDownloading(false);
            setDlProgress({
              phase: "error",
              message: "",
              percentEstimate: 0,
              done: true,
              error: e instanceof Error ? e.message : String(e),
            });
          });
      };
      if (localQueueActiveRef.current) {
        setPendingSwitch({ label: target.name, apply });
        toast.toast(t("toast.switchQueued", { name: target.name }));
        return;
      }
      apply();
    },
    [pendingLocalModel, downloading, refreshCachedModels, t, toast]
  );
  // The dedicated Download button: weights aren't on disk, fetch them.
  const downloadLocalModel = useCallback(() => activateLocalModel(false), [activateLocalModel]);

  // Abort an in-flight download. The backend emits a "cancelled" progress event
  // that resets the UI (handled in onModelProgress above).
  const cancelDownload = useCallback(() => {
    void api.cancelModelDownload().catch(() => {});
  }, []);

  // Fire a held model switch the moment the loaded model's queue goes idle.
  // Guarded so a switch requested mid-run applies exactly once, right after the
  // last image.
  useEffect(() => {
    if (!pendingSwitch || localQueueBlocking) return;
    const { apply } = pendingSwitch;
    setPendingSwitch(null);
    apply();
  }, [localQueueBlocking, pendingSwitch]);

  // Drop a queued switch and snap the bar's pending pick back to the model that's
  // actually loaded — so cancelling reads as "never mind, stay on the current one".
  const cancelPendingSwitch = useCallback(() => {
    setPendingSwitch(null);
    setPendingLocalModel(settings?.localModel ?? null);
  }, [settings?.localModel]);

  // "On disk" and "loaded in the engine" are different things now that several
  // models are kept cached: a model can be downloaded yet not active, in which
  // case selecting it is a restart, not a multi-GB download. Custom checkpoints
  // are always on disk — they're referenced in place and have no download URL,
  // so they never appear in the cache index.
  const localDownloaded =
    !!pendingLocalModel && settings?.localModel?.modelCode === pendingLocalModel.modelCode;
  const localCached =
    !!pendingLocalModel &&
    (!!pendingLocalModel.localPath ||
      cachedCodes.has(pendingLocalModel.modelCode) ||
      // The persisted selection is only ever set once weights landed (and is
      // cleared at startup when the file is gone), so the model the app is on
      // never has to wait for the cache index to be readable.
      localDownloaded);
  localCachedRef.current = localCached;
  const localReady = sidecar.state === "ready" && localDownloaded;
  const localNeedsDownload = !!pendingLocalModel && !localCached;
  // On disk but not resident in the engine — a different model is loaded, or
  // ours is but the engine is down. NOT something the user should have to click
  // through: the primary button stays "Generate" and activates the model (engine
  // restart + load) on the way to the run. "starting" is excluded: an activation
  // is already under way, so the job only has to wait for it.
  const localNeedsActivation =
    !!pendingLocalModel && localCached && !localReady && sidecar.state !== "starting";

  // The model whose params drive the current mode's generation (pending local
  // pick even before its weights are downloaded, so params preview correctly).
  const activeModel =
    (mode === "cloud" ? settings?.cloudModelInfo : pendingLocalModel) ?? null;

  // How many OPTIONAL reference-image slots the active model offers (0 hides
  // the card entirely). One rule for both kinds of model: the Go side resolves
  // it from the catalog for curated models and from the loading backend for user
  // checkpoints, so an Anima pick — which has no image input at all — reports 0
  // either way.
  const refSlots = activeModel?.refImages ?? 0;
  // Mirrored for the gallery drop path, which fires from a callback that must
  // not re-bind on every model change.
  const refSlotsRef = useRef(refSlots);
  refSlotsRef.current = refSlots;
  // The model's working resolution, used to scale incoming reference images:
  // pixels beyond it are discarded by the engine, so sending them only inflates
  // the request. A ref mirrors it for callbacks that must not re-subscribe on
  // every params tweak (the gallery drop path).
  const refDims = useMemo(
    () => (params ? resolveDims(activeModel, params) : { width: 1024, height: 1024 }),
    [activeModel, params]
  );
  const refDimsRef = useRef(refDims);
  refDimsRef.current = refDims;

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
  // local runs are enqueued, so the user can keep launching either way. Locally
  // it's the WEIGHTS being on disk that decides — not whether they're loaded:
  // the engine restart is queued behind the click, not in front of it.
  const localCanRun = engineInstalled && localCached && sidecar.state !== "error";
  const canGenerate = (mode === "cloud" ? cloudReady : localCanRun) && !!prompt.trim();

  // IDs of running local jobs the user asked to stop. Stopping hard-restarts the
  // sidecar, so the job's generate() rejects — this set lets settleJob treat that
  // rejection as a silent cancel (hide it) rather than a failure (error + toast).
  const cancelledIdsRef = useRef<Set<string>>(new Set());

  // Settle a job from its generate() promise — shared by the immediate cloud path
  // and the local queue dispatcher.
  const settleJob = useCallback((id: string, call: Promise<GenerationResult>) => {
    call
      .then((result) => {
        cancelledIdsRef.current.delete(id); // finished before the stop landed
        setJobs((js) =>
          js.map((j) => (j.id === id ? { ...j, status: "done", image: result, endedAt: Date.now() } : j))
        );
      })
      .catch((e) => {
        // User-stopped run: the sidecar was killed out from under it. Hide the
        // row silently — it's a cancel, not a failure.
        if (cancelledIdsRef.current.has(id)) {
          cancelledIdsRef.current.delete(id);
          setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "error", hidden: true } : j)));
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        setJobs((js) =>
          js.map((j) => (j.id === id ? { ...j, status: "error", error: msg, endedAt: Date.now() } : j))
        );
        toast.error(t("toast.genFailed"));
      });
  }, [toast, t]);

  // Settle a RESUMED cloud job (one that was interrupted by a prior app close
  // and reclaimed by the Go side). Arrives via the "cloud:resolved" event, not a
  // promise. Updates the hydrated Activity row, or adds one if the result landed
  // before its row was hydrated.
  const applyCloudResolved = useCallback((r: CloudResolved) => {
    setJobs((js) => {
      const exists = js.some((j) => j.id === r.jobId);
      if (r.error) {
        if (!exists) return js;
        return js.map((j) =>
          j.id === r.jobId ? { ...j, status: "error", error: r.error, endedAt: Date.now() } : j
        );
      }
      if (!r.result) return js;
      if (exists) {
        return js.map((j) =>
          j.id === r.jobId ? { ...j, status: "done", image: r.result!, endedAt: Date.now() } : j
        );
      }
      const now = Date.now();
      return [
        {
          id: r.jobId, mode: "cloud" as const, prompt: r.result.meta?.prompt ?? "",
          status: "done" as const, progress: null, image: r.result,
          queuedAt: now, startedAt: now, endedAt: now,
        },
        ...js,
      ];
    });
  }, []);

  // On launch: rehydrate the Activity list with cloud generations interrupted by
  // the last close (still running server-side), and subscribe to their
  // completion. The Go side resumes polling them a couple seconds after startup.
  useEffect(() => {
    void api
      .listPendingCloudJobs()
      .then((pending) => {
        if (!pending.length) return;
        setJobs((js) => {
          const seen = new Set(js.map((j) => j.id));
          const rows: Job[] = pending
            .filter((p) => !seen.has(p.jobId))
            .map((p) => ({
              id: p.jobId, mode: "cloud", prompt: p.prompt, status: "running",
              progress: null, queuedAt: Date.parse(p.createdAt) || Date.now(),
              // Elapsed counts from the original enqueue, not from this launch —
              // a job stuck for hours must LOOK stuck, not freshly started.
              startedAt: Date.parse(p.createdAt) || Date.now(),
              resumed: true,
            }));
          return rows.length ? [...rows, ...js] : js;
        });
      })
      .catch(() => {});
    return api.onCloudResolved(applyCloudResolved);
  }, [applyCloudResolved]);

  // Track which models are on disk. The Go side fires "model:cache" after every
  // change (startup reconcile, download, eviction, manual delete, purge), so the
  // picker badges and the primary button never go stale.
  useEffect(() => {
    refreshCachedModels();
    return api.onModelCacheChanged(refreshCachedModels);
  }, [refreshCachedModels]);

  // Settings rewritten by the Go side on its own — the stored model snapshots
  // re-resolved against the catalog, which lands a second or two after mount
  // (it needs the network). Adopt them, and follow the pending local pick along
  // if it's the same model, so the composer picks up a changed capability
  // (reference-image slots, formats, defaults) without a re-pick or a restart.
  useEffect(
    () =>
      api.onSettingsChanged((next) => {
        setSettings(next);
        setPendingLocalModel((cur) =>
          cur && next.localModel && cur.modelCode === next.localModel.modelCode ? next.localModel : cur
        );
      }),
    []
  );

  // Manual "recheck" — re-poll any still-pending cloud generations on demand.
  const recheckCloud = useCallback(() => {
    void api.recheckPendingCloud().catch(() => {});
    toast.toast(t("toast.cloudRechecking"));
  }, [toast, t]);

  const run = useCallback(
    (which: Mode) => {
      const p = prompt.trim();
      if (!p) return;
      // Local: the PENDING pick, not the loaded model — a job can be enqueued
      // for a cached model that's still being swapped in, and it must carry that
      // model's formats/defaults (the same ones the params panel is showing).
      const model =
        which === "cloud" ? settings?.cloudModelInfo : (pendingLocalModel ?? settings?.localModel);
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
      }
      // Reference images ride along in both modes now that a model declares how
      // many it takes; the Go side mirrors slot 0 onto sourceImage for the
      // existing engine contract, and drops them for a cloud model that
      // doesn't declare any.
      const refs = refImages.slice(0, refSlots).filter(Boolean) as string[];
      if (refs.length > 0) {
        req.refImages = refs;
        req.strength = strength;
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
        // already waiting in line, and modelCode pins it to the model it was
        // written for — the dispatcher won't hand it to another one.
        setJobs((js) => [
          {
            id, mode: "local", prompt: full, status: "queued", progress: null,
            queuedAt: now, request: req, modelCode: model?.modelCode,
          },
          ...js,
        ]);
      }
    },
    [prompt, pendingLocalModel, settings?.localModel, settings?.cloudModelInfo, params, refImages, refSlots, strength, settleJob]
  );

  // Local FIFO dispatcher — the sidecar runs one local job at a time. Whenever
  // no local job is running, start the oldest still-queued (non-cancelled) one.
  // dispatchedRef makes each job fire its generateLocal exactly once, even though
  // this effect re-runs on every jobs change (and under StrictMode double-invoke).
  const dispatchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Wait for the engine to be ready — after stopping a run the sidecar
    // hard-restarts (reloads the model), and queued jobs must hold until then.
    if (sidecar.state !== "ready") return;
    // A hidden (stopped) job may still be status "running" until its promise
    // settles; don't let it block the next queued job.
    if (jobs.some((j) => j.mode === "local" && j.status === "running" && !j.hidden)) return;
    let next: Job | undefined;
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      if (j.mode !== "local" || j.status !== "queued" || j.hidden) continue;
      // Enqueued for a model the engine doesn't have resident: it waits for the
      // swap (already under way — the primary button fires it) rather than
      // running under whatever is loaded right now.
      if (j.modelCode && loadedLocalCode && j.modelCode !== loadedLocalCode) continue;
      next = j;
      break;
    }
    if (!next || !next.request || dispatchedRef.current.has(next.id)) return;
    const job = next;
    const request = next.request;
    dispatchedRef.current.add(job.id);
    setJobs((js) =>
      js.map((j) => (j.id === job.id ? { ...j, status: "running", startedAt: Date.now(), progress: null } : j))
    );
    settleJob(job.id, api.generateLocal(request));
  }, [jobs, sidecar.state, loadedLocalCode, settleJob]);

  // --- Activity panel bookkeeping ------------------------------------------
  // Dismissing hides a finished OR queued row: for a queued local job this also
  // cancels it (the dispatcher skips hidden jobs, so it never runs). A running
  // job can't be dismissed (no cancel API yet). Finished images stay in the
  // gallery regardless — jobs are only the source of this session's fresh tiles.
  const dismissJob = useCallback(
    (id: string) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, hidden: true } : j))),
    []
  );
  // Stop a running local run, cancel a queued one, or give up on a wedged cloud
  // one — same button in the Activity list. A queued job just hides (the
  // dispatcher skips it). A running local job hides immediately and
  // hard-restarts the sidecar via the Go side; its generate() then rejects and
  // settleJob (cancelledIdsRef) keeps it silent.
  const stopJob = useCallback(
    async (job: Job) => {
      if (job.status === "queued") {
        dismissJob(job.id);
        return;
      }
      // A cloud run can't be cancelled server-side, but its pending record can be
      // forgotten — the escape hatch when a request_id never resolves and the row
      // would otherwise say "Running in the cloud…" forever. Resumed rows only:
      // a live run has no record yet, and gives up on its own at the poll budget.
      if (job.status === "running" && job.mode === "cloud" && job.resumed) {
        const ok = await confirm({
          title: t("queue.dropCloudTitle"),
          description: t("queue.dropCloudConfirm"),
          confirmLabel: t("queue.dismiss"),
          cancelLabel: t("common.cancel"),
        });
        if (!ok) return;
        dismissJob(job.id);
        void api.dropPendingCloudJob(job.id).catch(() => {});
        return;
      }
      if (job.status === "running" && job.mode === "local") {
        // Confirm first — stopping hard-restarts the engine (model reload), so an
        // accidental click is costly.
        const ok = await confirm({
          title: t("queue.stopTitle"),
          description: t("queue.stopConfirm"),
          confirmLabel: t("queue.stop"),
          cancelLabel: t("common.cancel"),
        });
        if (!ok) return;
        cancelledIdsRef.current.add(job.id);
        setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, hidden: true } : j)));
        void api.stopLocalGeneration().catch(() => {});
        toast.toast(t("toast.genStopped"));
      }
    },
    [dismissJob, confirm, toast, t]
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
      // A video can't seed img2img — ignore the gesture (the lightbox/menu also
      // hide the action for videos; this guards the drag path).
      if (!src || isVideoSrc(src)) return;
      // The selected model takes no reference image (an Anima pick, say): the
      // card isn't even mounted, so accepting the drop would swallow it in
      // silence. Say why instead.
      if (refSlotsRef.current < 1) {
        toast.toast(t("toast.modelTakesNoRefImage"));
        return;
      }
      setSourceImage(await prepareRefImage(src, refDimsRef.current.width, refDimsRef.current.height));
      setMode("local");
    } catch {
      /* fetch/read failure — ignore */
    }
  }, [toast, t]);

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

  // Create panel = img2img drop target. Highlighted (dropActive) both by a native
  // OS-file drag over it and by an in-app pointer image-drag (startImageDrag).
  const [dropActive, setDropActive] = useState(false);
  // The in-app pointer image-drag ghost (a gallery tile following the cursor).
  const [imageDrag, setImageDrag] = useState<{ src: string | null; x: number; y: number } | null>(null);

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
  // Native drop path — OS image files dragged in from Finder only.
  const onPanelDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragHasImage(e.dataTransfer)) return;
      e.preventDefault();
      setDropActive(false);
      const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
      if (file) void readFileAsDataURL(file).then((src) => void useAsImg2img(async () => src));
    },
    [useAsImg2img]
  );

  // In-app image drag (gallery tile → Create panel) via pointer events. A ghost
  // follows the cursor; the Create panel highlights while hovered; on release
  // over it, the tile becomes the img2img source. pointerup always fires, so this
  // is reliable in WKWebView (unlike native drop).
  const startImageDrag = useCallback(
    (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null) => {
      const sx = e.clientX, sy = e.clientY;
      const overCreate = (x: number, y: number) =>
        !!document.elementFromPoint(x, y)?.closest(".create-surface");
      beginPointerDrag(e, {
        onStart: () => setImageDrag({ src: previewSrc, x: sx, y: sy }),
        onMove: (x, y) => {
          setImageDrag((d) => (d ? { ...d, x, y } : d));
          setDropActive(overCreate(x, y));
        },
        onEnd: (x, y, moved) => {
          if (!moved) return;
          suppressTileClick = true;
          window.setTimeout(() => { suppressTileClick = false; }, 0);
          const drop = overCreate(x, y);
          setImageDrag(null);
          setDropActive(false);
          if (drop) void useAsImg2img(getSrc);
        },
      });
    },
    [useAsImg2img]
  );

  // Primary button: in local mode it only asks for a click of its own when the
  // weights aren't on disk (a multi-GB download is never implicit). Weights
  // already cached → it stays Generate / Add to queue, and swapping them into
  // the engine rides along with the run. Cmd/Ctrl+Enter triggers whichever is
  // current.
  const primary: ComposerAction = useMemo(() => {
    if (mode === "local" && downloading)
      return {
        label: activationIsLoad ? t("composer.loadingModelBtn") : t("composer.downloadingBtn"),
        onClick: () => {},
        disabled: true,
        busy: true,
        kind: "download",
      };
    if (mode === "local" && localNeedsDownload)
      return {
        label: t("composer.downloadModelBtn"),
        onClick: downloadLocalModel,
        disabled: !pendingLocalModel,
        busy: false,
        kind: "download",
      };
    return {
      // Local runs are enqueued one-at-a-time, so when the queue is already busy
      // the button adds to it rather than starting immediately — say so.
      label:
        mode === "local" && localQueueActive
          ? t("composer.addToQueueBtn")
          : t("composer.generateBtn"),
      onClick: () => {
        if (!canGenerate) return;
        run(mode);
        // Weights on disk but not resident (another model loaded, or the engine
        // down): swap them in BEHIND the job just queued — no download, straight
        // to the restart — and the dispatcher holds the job until the engine is
        // up with THIS model. A switch already held for a busy queue applies on
        // its own when the queue drains.
        if (mode !== "local" || !localNeedsActivation || pendingSwitch) return;
        if (pendingLocalModel?.localPath) {
          // User checkpoint: no cache index, its own activation path.
          void selectCustomModel(pendingLocalModel).catch(() => {});
        } else {
          activateLocalModel(true);
        }
      },
      disabled: !canGenerate,
      busy: false,
      kind: "generate",
    };
  }, [mode, downloading, activationIsLoad, localNeedsDownload, localNeedsActivation, pendingSwitch, pendingLocalModel, downloadLocalModel, activateLocalModel, selectCustomModel, canGenerate, localQueueActive, run, t]);

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
    blocked: paletteOpen || shortcutsOpen || settingsOpen || modelPickerOpen || !!customModelPath || !!lightbox,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const s = primaryHotkeyRef.current;
        if (s.blocked || s.disabled) return;
        e.preventDefault();
        s.onClick();
      } else if (e.key === "?" && !primaryHotkeyRef.current.blocked) {
        // Open the shortcuts sheet — but not while typing in a field.
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        e.preventDefault();
        setShortcutsOpen(true);
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
    if (downloading) return activationIsLoad ? t("hint.loadingModel") : t("hint.downloadingModel");
    if (localNeedsDownload) return t("hint.clickDownload", { name: pendingLocalModel?.name });
    if (sidecar.state === "error") return t("hint.engineError");
    // Cached but not resident: generating loads it first, so say that rather
    // than sending the user off to the engine control.
    if (localNeedsActivation) return t("hint.willLoad", { name: pendingLocalModel?.name });
    if (sidecar.state === "starting") return t("hint.engineStarting");
    if (sidecar.state !== "ready") return t("hint.startEngine");
    return settings?.localModel?.name ?? t("hint.pickModel");
  }, [mode, cloudConfigured, downloading, activationIsLoad, localNeedsDownload, localNeedsActivation, pendingLocalModel, sidecar.state, settings?.cloudModelInfo, settings?.localModel, settings?.paymentMode, engineInstalled, t]);

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
        // The primary button's own handler — so the palette also swaps in a
        // cached-but-unloaded model instead of queueing a job nothing runs.
        run: () => primary.onClick(),
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
      id: "open-activity",
      group: gPanels,
      label: t("palette.openActivity"),
      icon: <Activity />,
      keywords: "queue runs jobs",
      run: () => setActivityOpen(true),
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
    cmds.push({ id: "shortcuts", group: gApp, label: t("shortcuts.title"), icon: <Keyboard />, keywords: "keyboard keys help", run: () => setShortcutsOpen(true) });

    return cmds;
  }, [
    t, canGenerate, primary, mode, engineInstalled, sidecar.state, settings?.localModel,
    installEngine, stopEngine, startEngine,
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
            widths={panelWidths}
            onWidthsChange={setPanelWidths}
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
                      // max-h leaves a bottom gap: the surface starts ~118px down
                      // (topbar + panel header + sticky top-4), so subtract that
                      // plus breathing room — otherwise the last card (Parameters)
                      // sits flush against / just under the window edge.
                      // scrollbar-gutter:stable reserves the scrollbar its own lane
                      // beyond the right padding, so it never clips the cards'
                      // rounded corners (Windows/WebView2 shows a wide scrollbar).
                      "create-surface relative flex flex-col gap-4 p-3 pb-4 xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto xl:overflow-x-hidden xl:[scrollbar-gutter:stable]",
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
                        <span className="text-foreground text-sm font-semibold">{t("refImage.dropHere")}</span>
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
                    {!firstRun && mode === "cloud" && (
                      <PaymentBar
                        settings={settings}
                        onModeChange={setPaymentMode}
                        onConfigure={openSettings}
                      />
                    )}

                    {/* 2. Model */}
                    {!firstRun && (
                      <ModelBar
                        mode={mode}
                        settings={settings}
                        onModelSwitched={handleSettingsSaved}
                        pendingLocalModel={pendingLocalModel}
                        onSelectLocal={setPendingLocalModel}
                        cachedCodes={cachedCodes}
                        downloading={downloading}
                        loadingCached={activationIsLoad}
                        progress={dlProgress}
                        onCancelDownload={cancelDownload}
                        onAddCustom={addCustomModel}
                        onSelectCustom={selectCustomModel}
                        onRemoveCustom={removeCustomModel}
                        pickerOpen={modelPickerOpen}
                        onPickerOpenChange={setModelPickerOpen}
                      />
                    )}

                    {/* Held model switch: shown while the local queue drains, so
                        the user knows their pick applies after the current runs. */}
                    {!firstRun && pendingSwitch && (
                      <div className="border-primary/30 bg-primary/5 text-foreground/80 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs">
                        <Clock className="text-primary size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {t("modelBar.switchQueued", { name: pendingSwitch.label })}
                        </span>
                        <button
                          type="button"
                          onClick={cancelPendingSwitch}
                          className="text-muted-foreground/70 hover:text-destructive shrink-0 font-medium transition-colors"
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    )}

                    {firstRun ? (
                      /* First run: a guided setup replaces the (non-functional)
                         composer until the engine is installed or cloud is set up. */
                      <FirstRunSetup
                        onInstallDone={() => void api.getSettings().then(setSettings)}
                        onOpenCloudSettings={() => openSettings("cloud")}
                        onSkip={skipOnboarding}
                      />
                    ) : (
                      <>
                        {/* 3. Prompt (with pre-prompt above + negative below) */}
                        <Composer
                          prompt={prompt}
                          onPromptChange={setPrompt}
                          showModelFields={!!params}
                          prePrompt={params?.prePrompt ?? ""}
                          onPrePromptChange={(v) => setParams((pp) => (pp ? { ...pp, prePrompt: v } : pp))}
                          negativePrompt={params?.negativePrompt ?? ""}
                          onNegativePromptChange={(v) => setParams((pp) => (pp ? { ...pp, negativePrompt: v } : pp))}
                        />

                        {/* 3b. Reference images — its own card. Optional, and a
                            different kind of input from the text above, so it
                            reads as a separate step rather than a field. */}
                        {refSlots > 0 && (
                          <RefImageCard
                            slots={refSlots}
                            images={refImages}
                            onImagesChange={setRefImages}
                            targetW={refDims.width}
                            targetH={refDims.height}
                            strength={strength}
                            onStrengthChange={setStrength}
                          />
                        )}

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

                        {/* 6. The run button — last in the panel, but pinned to
                            the bottom of the viewport so it never scrolls away. */}
                        <PrimaryAction action={primary} contextHint={contextHint} mode={mode} />
                      </>
                    )}
                  </div>
                ),
              },
              gallery: {
                title: t("panels.gallery"),
                icon: <Images />,
                grow: true,
                content: (
                  <Gallery
                    jobs={doneJobs}
                    onUseAsSource={useAsImg2img}
                    onImageDragStart={startImageDrag}
                    onReuseSettings={reuseSettings}
                    onHideJob={dismissJob}
                  />
                ),
              },
            }}
          />
        </div>
      </main>

      {/* Activity — a persistent bottom-right dock (widget + overlay) instead of
          an in-layout panel, so it's always reachable and never pushed off-screen. */}
      <ActivityDock
        jobs={jobs}
        open={activityOpen}
        onOpenChange={setActivityOpen}
        onDismiss={dismissJob}
        onStop={stopJob}
        onRecheck={recheckCloud}
        onOpenImage={setLightbox}
        onClear={clearFinished}
      />

      {/* Activity-panel viewer: a single image (no prev/next, no delete) but the
          same action bar — reuses the gallery Lightbox with a one-item sequence. */}
      {lightbox && (
        <Lightbox
          items={[{
            name: null,
            meta: lightbox.meta,
            kind: isVideoSrc(lightbox.src) ? "video" : "image",
            getSrc: async () => lightbox.src,
          }]}
          index={0}
          onIndex={() => {}}
          onClose={() => setLightbox(null)}
          onUseAsSource={useAsImg2img}
          onReuseSettings={reuseSettings}
          onDelete={() => {}}
        />
      )}

      {/* Drag ghost — a gallery tile following the cursor during a pointer
          image-drag toward the Create panel. */}
      {imageDrag && (
        <div
          className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-1/2"
          style={{ left: imageDrag.x, top: imageDrag.y }}
        >
          <div className="size-24 rotate-3 overflow-hidden rounded-xl border-2 border-[var(--brand-from)] opacity-90 shadow-2xl">
            {imageDrag.src ? (
              <img src={imageDrag.src} alt="" className="size-full object-cover" />
            ) : (
              <div className="bg-muted flex size-full items-center justify-center">
                <ImageIcon className="text-muted-foreground/50 size-6" />
              </div>
            )}
          </div>
        </div>
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
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
// FirstRunSetup — a guided welcome shown in the Create panel on first run (no
// local engine AND no cloud payment configured). Reuses LocalEngineSection for
// the install step; offers the cloud path as an alternative; skippable. As soon
// as either path completes, `firstRun` flips false and the normal composer
// returns — this component doesn't drive that transition itself.
// ---------------------------------------------------------------------------
function FirstRunSetup({
  onInstallDone,
  onOpenCloudSettings,
  onSkip,
}: {
  onInstallDone: () => void;
  onOpenCloudSettings: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="bg-card relative overflow-hidden rounded-2xl border p-4 shadow-sm">
      <div className="canvas-glow pointer-events-none absolute inset-0" />
      <div className="relative flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="brand-surface flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--brand-to)_60%,transparent)]">
            <Sparkles className="size-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t("onboarding.title")}</h2>
            <p className="text-muted-foreground text-xs leading-snug">{t("onboarding.subtitle")}</p>
          </div>
        </div>

        {/* Path A — install the local engine (self-contained install UI). */}
        <div className="grid gap-1.5">
          <span className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-wide">
            {t("onboarding.localLabel")}
          </span>
          <LocalEngineSection onInstallDone={onInstallDone} />
        </div>

        {/* Path B — use the cloud (opens Settings → Cloud payment). */}
        <div className="grid gap-1.5">
          <span className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-wide">
            {t("onboarding.cloudLabel")}
          </span>
          <button
            type="button"
            onClick={onOpenCloudSettings}
            className="border-border/60 hover:border-primary/40 hover:bg-muted/40 group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors"
          >
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
              <Cloud className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("onboarding.cloudTitle")}</div>
              <div className="text-muted-foreground text-xs">{t("onboarding.cloudHint")}</div>
            </div>
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          </button>
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="text-muted-foreground hover:text-foreground justify-self-start text-[11px] font-medium transition-colors"
        >
          {t("onboarding.skip")}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Composer — the prompt input + primary action. Mode lives above (ModeToggle),
// not here; several generations can be launched back-to-back.
// ---------------------------------------------------------------------------

// Grow a textarea to fit its content (clamped by the element's CSS min/max-h),
// re-measuring whenever the value changes — including external edits like
// "reuse settings" or an img2img drop that repopulate the prompt.
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

// Composer — prompting only: quality tags, the prompt itself, and the negative
// prompt. Reference images (RefImageCard) and the run button (PrimaryAction) are
// siblings in the Create panel, not tenants of this card: mixing an image
// dropzone into a stack of text fields made both harder to read.
function Composer({
  prompt,
  onPromptChange,
  showModelFields,
  prePrompt,
  onPrePromptChange,
  negativePrompt,
  onNegativePromptChange,
}: {
  prompt: string;
  onPromptChange: (v: string) => void;
  showModelFields: boolean;
  prePrompt: string;
  onPrePromptChange: (v: string) => void;
  negativePrompt: string;
  onNegativePromptChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  // ⌘/Ctrl+Enter is handled globally in App (works from anywhere, not just this
  // field), so the textarea needs no key handler of its own.
  const promptRef = useAutoGrow(prompt);
  const preRef = useAutoGrow(prePrompt);
  const negRef = useAutoGrow(negativePrompt);

  return (
    <div className="composer bg-card rounded-2xl border">
      {/* Pre-prompt (quality tags) — secondary: small, dim, tucked at the top. */}
      {showModelFields && (
        <label className="hover:bg-muted/30 focus-within:bg-muted/30 block rounded-t-2xl px-5 pb-2 pt-2.5 transition-colors">
          <span className="text-muted-foreground/70 text-[11px] font-medium uppercase tracking-wide">
            {t("composer.qualityTags")}
          </span>
          <textarea
            ref={preRef}
            value={prePrompt}
            onChange={(e) => onPrePromptChange(e.target.value)}
            placeholder={t("composer.qualityTagsPlaceholder")}
            rows={1}
            className="placeholder:text-muted-foreground/40 text-muted-foreground/90 block max-h-24 w-full resize-none border-0 bg-transparent text-xs leading-snug outline-none"
          />
        </label>
      )}

      {/* Prompt — the hero: largest text, most room, clear separation. */}
      <div className={cn("relative", showModelFields ? "border-border/60 border-y" : "")}>
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder={t("composer.promptPlaceholder")}
          rows={3}
          className={cn(
            "placeholder:text-muted-foreground/60 focus:bg-muted/15 block max-h-72 min-h-32 w-full resize-none border-0 bg-transparent px-5 pb-7 pt-4 text-base font-medium leading-relaxed outline-none transition-colors",
            showModelFields ? "" : "rounded-t-2xl"
          )}
        />
        {/* Clear + character count — only while there's something to clear. The
            count sits in a faint pill so it stays legible over the last line. */}
        {prompt.length > 0 && (
          <div className="absolute bottom-1.5 right-2.5 flex items-center gap-1.5">
            <span className="bg-card/70 text-muted-foreground/60 rounded px-1 text-[10px] tabular-nums backdrop-blur-sm">
              {t("composer.charCount", { count: prompt.length })}
            </span>
            <button
              type="button"
              onClick={() => onPromptChange("")}
              title={t("composer.clear")}
              aria-label={t("composer.clear")}
              className="text-muted-foreground/50 hover:text-foreground hover:bg-muted rounded p-0.5 transition-colors"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Negative prompt — secondary, mirrors the pre-prompt styling, and now
          the card's last child (hence the rounded bottom). */}
      {showModelFields && (
        <label className="hover:bg-muted/30 focus-within:bg-muted/30 block rounded-b-2xl px-5 pb-3 pt-2 transition-colors">
          <span className="text-muted-foreground/70 text-[11px] font-medium uppercase tracking-wide">
            {t("composer.negativePrompt")}
          </span>
          <textarea
            ref={negRef}
            value={negativePrompt}
            onChange={(e) => onNegativePromptChange(e.target.value)}
            placeholder={t("composer.negativePlaceholder")}
            rows={1}
            className="placeholder:text-muted-foreground/40 text-muted-foreground/90 block max-h-24 w-full resize-none border-0 bg-transparent text-xs leading-snug outline-none"
          />
        </label>
      )}

    </div>
  );
}

// PrimaryAction — the run button plus its one-line context hint, as a bar that
// STICKS to the bottom of whatever is scrolling it. It used to sit inside the
// composer, which pushed it out of reach as soon as the panel grew (reference
// images, parameters, a long negative prompt): the whole point of the panel is
// to end in a click, so the click follows the user.
//
// Two scrollports, one rule. On xl the Create surface scrolls internally, so the
// bar pins to the bottom of the panel; below xl the page scrolls, so it pins to
// the bottom of the window. Either way it's the last child, so it never covers
// anything. z-30 keeps it under the Activity dock (z-40), and the reserved lane
// below xl keeps the button out of that dock's corner on stacked layouts.
//
// It also carries its own surface (.run-capsule, mode-tinted like the panel it
// floats over) so it doesn't read as one more card in the stack — see index.css.
function PrimaryAction({
  action,
  contextHint,
  mode,
}: {
  action: ComposerAction;
  contextHint: string;
  mode: Mode;
}) {
  return (
    <div className="sticky bottom-1 z-30 flex justify-end max-xl:pr-36">
      {/* Content-sized and right-aligned, so it reads as one floating capsule
          rather than a docked toolbar spanning the panel. */}
      <div
        data-mode={mode}
        className="run-capsule flex max-w-full items-center gap-3 rounded-full border py-1.5 pl-4 pr-1.5 backdrop-blur"
      >
        <span
          className="text-muted-foreground/80 hidden min-w-0 max-w-[15rem] truncate text-[11px] sm:block"
          title={contextHint}
        >
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
              title: `${f.width}×${f.height}${f.ratio ? ` · ${formatRatio(f)}` : ""}`,
              label: (
                <span className="capitalize">
                  {formatName(f, t)}
                  {f.ratio && (
                    <span className="text-muted-foreground/70 ml-1 text-[10px] normal-case">
                      {formatRatio(f)}
                    </span>
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

// Reference-image card inside the composer. One slot per image the model
// accepts (ModelInfo.refImages): one for img2img, two for a video model taking
// a first and last frame. Reference images are ALWAYS optional — the card says
// so, because an empty slot reads as something missing otherwise.
//
// Rendering slots from a count (rather than special-casing "the" source image)
// is what lets a two-image model land with no layout change.
function RefImageCard({
  slots,
  images,
  onImagesChange,
  targetW,
  targetH,
  strength,
  onStrengthChange,
}: {
  /** How many slots to render (1 or 2). The card isn't mounted at 0. */
  slots: number;
  /** Current images by slot; holes are empty slots. */
  images: (string | null)[];
  onImagesChange: (next: (string | null)[]) => void;
  /** The model's working resolution — incoming images are scaled to fit it. */
  targetW: number;
  targetH: number;
  strength: number;
  onStrengthChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  const pair = slots >= 2;
  const filled = images.slice(0, slots).some(Boolean);

  // Every image entering a slot is scaled to the model's working resolution
  // first: a raw phone photo is several MB of base64, and the extra pixels are
  // discarded by the engine anyway.
  const setSlot = async (i: number, value: string | null) => {
    const prepared = value ? await prepareRefImage(value, targetW, targetH) : null;
    const next = Array.from({ length: slots }, (_, k) => images[k] ?? null);
    next[i] = prepared;
    onImagesChange(next);
  };

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {pair ? t("refImage.titlePair") : t("refImage.title")}
          <span className="text-muted-foreground/50 ml-1.5 normal-case">
            · {t("refImage.optional")}
          </span>
        </span>
        {filled && (
          <button
            type="button"
            onClick={() => onImagesChange([])}
            className="text-muted-foreground/70 hover:text-foreground text-[11px]"
          >
            {t("common.clear")}
          </button>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div className="flex gap-2">
          {Array.from({ length: slots }, (_, i) => (
            <RefImageSlot
              key={i}
              image={images[i] ?? null}
              onChange={(v) => void setSlot(i, v)}
              label={pair ? (i === 0 ? t("refImage.firstFrame") : t("refImage.lastFrame")) : ""}
            />
          ))}
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          {filled ? (
            // Strength only means something once there's an image to denoise
            // from; showing the slider on an empty card would imply otherwise.
            <label className="block">
              <span className="text-muted-foreground text-[11px]">
                {t("refImage.strength", { strength: strength.toFixed(2) })}
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={strength}
                onChange={(e) => onStrengthChange(Number(e.target.value))}
                className="range mt-1 w-full"
              />
              <span className="text-muted-foreground/60 text-[10px]">
                {t("refImage.strengthHint")}
              </span>
            </label>
          ) : (
            <p className="text-muted-foreground/70 text-[11px] leading-snug">
              {pair ? t("refImage.hintPair") : t("refImage.hint")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// One square slot: click or drop to fill, hover to remove. Kept dumb (no
// knowledge of roles or counts) so the card owns all the layout decisions.
function RefImageSlot({
  image,
  onChange,
  label,
}: {
  image: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const read = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          read(e.target.files?.[0]);
          e.target.value = ""; // let the same file be re-picked later
        }}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation(); // don't also trigger the panel-wide drop target
          setOver(false);
          read(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "group/slot relative size-16 shrink-0 overflow-hidden rounded-lg border transition-colors",
          image ? "border-border" : "border-border/70 border-dashed",
          over && "border-primary bg-primary/5"
        )}
      >
        {image ? (
          <>
            <img src={image} alt={t("refImage.sourceAlt")} className="size-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label={t("common.remove")}
              title={t("common.remove")}
              className="bg-background/80 text-muted-foreground hover:text-destructive absolute right-1 top-1 rounded p-0.5 opacity-0 transition group-hover/slot:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 flex size-full flex-col items-center justify-center gap-1 transition-colors"
          >
            <ImageIcon className="size-4" />
            <span className="text-[10px] leading-none">{t("refImage.add")}</span>
          </button>
        )}
      </div>
      {label && <span className="text-muted-foreground/70 text-[10px]">{label}</span>}
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
  /** "video" hides image-only actions (img2img) in the menu/lightbox. */
  kind?: string;
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
  startImageDrag: (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null) => void;
};

// Basename of a saved path, for matching a session job to its file on disk.
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function Gallery({
  jobs,
  onUseAsSource,
  onImageDragStart,
  onReuseSettings,
  onHideJob,
}: {
  jobs: Job[];
  onUseAsSource: (getSrc: () => Promise<string>) => void;
  onImageDragStart: (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null) => void;
  onReuseSettings: (meta: GenerationMeta) => void;
  onHideJob: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
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
        kind: isVideoSrc(img.imageBase64) ? "video" : "image",
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
        toast.toast(t("toast.deleted", { count: names.length }));
      });
    },
    [hideJobsFor, refreshFacets, toast, t]
  );

  const deleteOne = useCallback(
    async (name: string) => {
      const ok = await confirm({
        title: t("gallery.deleteTitle", { count: 1 }),
        description: t("gallery.deleteConfirm", { name }),
        confirmLabel: t("gallery.deleteAction"),
        cancelLabel: t("common.cancel"),
      });
      if (ok) deleteNames([name]);
    },
    [deleteNames, confirm, t]
  );

  const deleteSelected = useCallback(async () => {
    const names = [...selected];
    if (names.length === 0) return;
    const ok = await confirm({
      title: t("gallery.deleteTitle", { count: names.length }),
      description: t("gallery.deleteSelectedConfirm", { count: names.length }),
      confirmLabel: t("gallery.deleteAction"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) deleteNames(names);
  }, [selected, deleteNames, confirm, t]);

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
      // A click that immediately followed a pointer image-drag isn't a real
      // click — swallow it so the lightbox doesn't open on drop.
      if (suppressTileClick) return;
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
    startImageDrag: onImageDragStart,
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
      kind: g.kind,
      getSrc: () => (g.src ? Promise.resolve(g.src) : api.getSavedImage(g.name)),
    });
    tiles.push({ key: g.name, el: <SavedTile image={g} index={index} shared={shared} onDelete={deleteOne} /> });
  }
  viewItemsRef.current = viewItems;
  const columns: { key: string; el: React.ReactElement }[][] = Array.from({ length: cols }, () => []);
  tiles.forEach((t, i) => columns[i % cols].push(t));
  const empty = tiles.length === 0;
  // First page still loading → show a skeleton grid, not the "no images" empty
  // state (which used to flash before the first page arrived).
  const initialLoading = empty && loading;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar facets={facets} filter={filter} onChange={setFilter} />
        <ColumnPicker cols={cols} onChange={setCols} />
      </div>

      {initialLoading ? (
        <GallerySkeleton cols={cols} />
      ) : empty ? (
        <div className="border-border/60 text-muted-foreground/70 relative flex min-h-[60vh] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed lg:min-h-[70vh]">
          <div className="canvas-glow pointer-events-none absolute inset-0" />
          <div className="brand-surface relative flex size-12 items-center justify-center rounded-2xl text-white shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--brand-to)_60%,transparent)]">
            <ImageIcon className="size-5" strokeWidth={1.75} />
          </div>
          <p className="relative text-sm">
            {filtered ? t("gallery.emptyFiltered") : t("gallery.empty")}
          </p>
          {filtered && (
            <button
              type="button"
              onClick={() => setFilter({ engine: "", modelCode: "", source: "", text: "" })}
              className="text-foreground hover:bg-muted relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
            >
              <X className="size-3.5" /> {t("gallery.clearFilters")}
            </button>
          )}
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
      {/* Loading the NEXT page (not the first) → append a row of skeleton tiles. */}
      {loading && !initialLoading && <GallerySkeleton cols={cols} rows={1} />}

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
    <Select size="sm" value={value} onChange={onChange} className="max-w-40" aria-label={label}>
      <option value="">{t("gallery.filterAll", { label })}</option>
      {facets.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label} ({f.count})
        </option>
      ))}
    </Select>
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

// Masonry-shaped skeleton grid shown while a gallery page loads, so the layout
// is reserved instead of a bare spinner (no reflow when the images arrive).
function GallerySkeleton({ cols, rows = 3 }: { cols: number; rows?: number }) {
  const ratios = [1, 1.3, 0.82, 1.15, 0.95, 1.25];
  return (
    <div className="flex items-start gap-3">
      {Array.from({ length: cols }).map((_, ci) => (
        <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3">
          {Array.from({ length: rows }).map((_, ri) => (
            <Skeleton
              key={ri}
              className="w-full rounded-2xl"
              style={{ aspectRatio: ratios[(ci + ri * cols) % ratios.length] }}
            />
          ))}
        </div>
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
      // Pointer-based drag (not native HTML5) → reliable in WKWebView. A move
      // past threshold starts the img2img drag; a plain click still opens the
      // tile. Videos can't seed img2img → no drag affordance for them.
      onPointerDown={(e) => {
        if (image.kind === "video" || isVideoSrc(srcRef.current)) return;
        shared.startImageDrag(e, ensureSrc, srcRef.current);
      }}
      className={cn(
        "rise-in group bg-muted/40 relative cursor-zoom-in overflow-hidden rounded-2xl ring-1 transition-shadow duration-200 hover:shadow-lg",
        selected ? "ring-2 ring-[var(--brand-to)]" : "ring-border/60"
      )}
      title={image.name}
      // Capped, repeating stagger so a page of tiles cascades in without long
      // delays on later pages (infinite scroll).
      style={{ aspectRatio: aspect, animationDelay: `${(index % 10) * 30}ms` }}
      onClick={(e) => shared.tileClick(e, image.name, index)}
      onContextMenu={(e) =>
        shared.openMenu(e, {
          index,
          name: image.name,
          savedPath: image.savedPath || undefined,
          meta: image.meta,
          kind: image.kind,
          getSrc: ensureSrc,
        })
      }
    >
      {src ? (
        image.kind === "video" || isVideoSrc(src) ? (
          // Muted looping inline preview — the tile IS the thumbnail. Controls
          // live in the lightbox; the tile stays a simple click target.
          <video
            src={src}
            muted
            loop
            autoPlay
            playsInline
            draggable={false}
            className="animate-in fade-in h-full w-full object-cover duration-300"
          />
        ) : (
          // draggable=false: an <img> is natively draggable, which would start a
          // browser image-drag and cancel our pointer-based img2img drag.
          <img
            src={src}
            alt={image.name}
            draggable={false}
            className="animate-in fade-in h-full w-full object-cover duration-300"
          />
        )
      ) : (
        <Skeleton className="h-full w-full rounded-none" />
      )}
      {(image.kind === "video" || isVideoSrc(src)) && (
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/55 p-1 text-white">
          <Play className="size-3" fill="currentColor" />
        </span>
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
        {target.kind !== "video" && (
          <MenuItem
            icon={<ImageIcon />}
            label={t("gallery.ctxUseAsSource")}
            onClick={run(() => onUseAsSource(target.getSrc))}
          />
        )}
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
  // Click-to-zoom: a 2× magnifier whose focus follows the cursor. Reset on nav.
  const [zoom, setZoom] = useState(false);
  const [origin, setOrigin] = useState("50% 50%");
  useEffect(() => setZoom(false), [index]);
  // Distraction-free view: hide the meta panel, go solid black, fill the window.
  const [full, setFull] = useState(false);

  const total = items.length;
  const current = items[index];
  const lightboxAspect =
    current?.meta?.width && current?.meta?.height ? current.meta.width / current.meta.height : 1;
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
      // Esc leaves fullscreen first, then closes the viewer.
      if (e.key === "Escape") setFull((f) => (f ? false : (onClose(), false)));
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "f" || e.key === "F") setFull((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  if (!current) return null;
  const meta = current.meta;

  const iconBtn =
    "rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10";

  // Portal to <body>: the gallery renders inside <main> (relative z-10), whose
  // stacking context would otherwise trap this overlay below root-level fixed
  // chrome like the Activity dock.
  return createPortal(
    <div
      className={cn(
        "animate-in fade-in fixed inset-0 z-50 flex items-center justify-center",
        full ? "bg-black p-0" : "bg-black/85 p-6 backdrop-blur-sm"
      )}
      onClick={onClose}
    >
      {/* Top bar: counter + actions + close. */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium tabular-nums text-white">
          {t("gallery.counter", { i: index + 1, n: total })}
        </span>
        <div className="flex items-center gap-1.5">
          {/* img2img needs an image source — hidden for videos. */}
          {!isVideoSrc(src) && (
            <button type="button" className={iconBtn} title={t("gallery.ctxUseAsSource")} aria-label={t("gallery.ctxUseAsSource")} onClick={() => onUseAsSource(current.getSrc)}>
              <ImageIcon className="size-5" />
            </button>
          )}
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
          <button
            type="button"
            className={iconBtn}
            title={full ? t("gallery.exitFullscreen") : t("gallery.fullscreen")}
            aria-label={full ? t("gallery.exitFullscreen") : t("gallery.fullscreen")}
            onClick={() => setFull((f) => !f)}
          >
            {full ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />}
          </button>
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
        className={cn(
          "flex w-full flex-col items-center",
          full
            ? "h-full max-w-none gap-0"
            : "max-h-full max-w-6xl gap-4 md:flex-row md:items-stretch"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          {loading && !src && (
            // A dimensioned placeholder (from the known aspect) so the frame
            // doesn't jump when the full image resolves.
            <div
              className="skeleton max-h-[85vh] w-full max-w-[80vmin] rounded-xl bg-white/10"
              style={{ aspectRatio: lightboxAspect }}
            >
              <Loader2 className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70" />
            </div>
          )}
          {src &&
            (isVideoSrc(src) ? (
              // Video result (WAN): native controls, autoplay+loop, no magnifier
              // (zoom is an image affordance). Click falls through to the video's
              // own controls, so stop propagation to keep the overlay open.
              <video
                src={src}
                controls
                autoPlay
                loop
                playsInline
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "animate-in fade-in zoom-in-95 min-h-0 object-contain",
                  full ? "max-h-screen max-w-full" : "max-h-[85vh] rounded-xl shadow-2xl"
                )}
              />
            ) : (
              <img
                src={src}
                alt=""
                draggable={false}
                onClick={(e) => { e.stopPropagation(); setZoom((z) => !z); }}
                onMouseMove={(e) => {
                  if (!zoom) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  setOrigin(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`);
                }}
                onMouseLeave={() => setOrigin("50% 50%")}
                style={{ transformOrigin: origin, transform: zoom ? "scale(2)" : "scale(1)" }}
                className={cn(
                  "animate-in fade-in zoom-in-95 min-h-0 object-contain transition-transform duration-150",
                  // Fullscreen: edge-to-edge, no frame. Otherwise: framed with a cap.
                  full ? "max-h-screen max-w-full" : "max-h-[85vh] rounded-xl shadow-2xl",
                  zoom ? "cursor-zoom-out" : "cursor-zoom-in"
                )}
              />
            ))}
        </div>
        {!full && meta && <MetaPanel meta={meta} />}
      </div>

      {/* Keyboard-hint footer — discoverable navigation + zoom affordance. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
        <div className="flex items-center gap-3 rounded-full bg-white/10 px-3 py-1 text-[11px] text-white/70 backdrop-blur">
          {total > 1 && (
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-white/15 px-1">←</kbd>
              <kbd className="rounded bg-white/15 px-1">→</kbd>
              {t("gallery.lbNav")}
            </span>
          )}
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-white/15 px-1">F</kbd>
            {full ? t("gallery.exitFullscreen") : t("gallery.fullscreen")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded bg-white/15 px-1">Esc</kbd>
            {t("common.close")}
          </span>
          <span className="hidden sm:inline">{t("gallery.lbZoom")}</span>
        </div>
      </div>
    </div>,
    document.body
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
