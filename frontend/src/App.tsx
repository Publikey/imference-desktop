import { ActivityDock } from "@/components/ActivityDock";
import { CommandPalette, modLabel, type Command } from "@/components/CommandPalette";
import { CustomModelDialog } from "@/components/CustomModelDialog";
import { LocalReadinessCard } from "@/components/LocalReadinessCard";
import { LogPanel } from "@/components/LogPanel";
import { CloudLoraCard, LORA_BACKENDS, LoraCard, loraFits } from "@/components/LoraCard";
import { ModelBar } from "@/components/ModelBar";
import {
  PanelBoard,
  restoreHidden,
  usePanelLayout,
  visibleColumns,
  type PanelId,
} from "@/components/PanelBoard";
import { PANEL_ORDER, PanelIcon } from "@/components/PanelToggles";
import { PaymentBar } from "@/components/PaymentBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CloudHistoryDialog } from "@/components/CloudHistoryDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { EditEmpty, ToolEditor, defaultToolFor, type ToolSource } from "@/components/ToolEditor";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { useWebPay } from "@/lib/web-pay";
import { WebGalleryBanner } from "@/components/WebGallerySection";
import { WebPayNotice, WebPaymentBar } from "@/components/WebPay";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { prepareRefImage } from "@/lib/image";
import { installLogCapture } from "@/lib/log-capture";
import { beginPointerDrag } from "@/lib/pointer-drag";
import { isWeb, OPEN_HISTORY_EVENT, OPEN_SETTINGS_EVENT, SETTINGS_CHANGED_EVENT, notifyBalanceChanged, onBalanceMaybeChanged } from "@/lib/target";
import { setThemePref } from "@/lib/theme";
import { isEditModel, refreshTools } from "@/lib/tools";
import type {
  AppSettings,
  CloudLoraRef,
  CloudResolved,
  ComponentsProgress,
  ComponentsReadiness,
  GenerationMeta,
  GenerationRequest,
  GenerationResult,
  InstallProgress,
  Job,
  LogEntry,
  LoraRef,
  ModelInfo,
  PaymentMode,
  SidecarStatus,
  ToolRunRequest,
  ToolRunResult,
  UpdateInfo,
} from "@/lib/types";
import { cn, creditsToUSD } from "@/lib/utils";
import { api } from "@/lib/wails-bridge";
import {
  Activity,
  Brush,
  Clock,
  Cloud,
  Cpu,
  Download,
  ImageIcon,
  Images,
  History,
  Keyboard,
  Languages,
  Monitor,
  Moon,
  Play,
  ScrollText,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UpdateBanner } from "./app/Banners";
import { Composer, PrimaryAction } from "./app/Composer";
import { FirstRunSetup } from "./app/FirstRunSetup";
import { FormatSelector } from "./app/FormatSelector";
import { Gallery, type LightboxItem } from "./app/Gallery";
import { Header } from "./app/Header";
import { Welcome, welcomeDone } from "./app/Welcome";
import { Lightbox } from "./app/Lightbox";
import {
  CUSTOM_FORMAT,
  type GenParams,
  clampToCatalog,
  defaultParams,
  dimsForModel,
  formatOptions,
  resolveDims,
  runCost,
  snapDim,
} from "./app/model-params";
import { ParamsPanel } from "./app/ParamsPanel";
import { RefImageCard } from "./app/RefImages";
import {
  type Blocker,
  type ComposerAction,
  type Mode,
  dragHasImage,
  flagBlockers,
  isVideoSrc,
  nextJobId,
  readFileAsDataURL,
  readWebDraft,
  tileClickGuard,
  writeWebDraft,
} from "./app/shared";
import { friendlyPayError } from "@/lib/pay-errors";
import { openPayDialog } from "@/lib/web-pay";
import { payProblem, usePayState } from "@/lib/pay-state";

// Module-load side effect: install console + window error hooks before any
// component renders. The api wrapping itself happens inside wails-bridge.ts
// so SettingsDialog and any future component that imports `api` get the
// logged version automatically.
installLogCapture();

export default function App() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: "idle" });
  // Web: the prompt survives the trip to Stripe and the reload after signing in.
  const [prompt, setPrompt] = useState(() => (isWeb ? readWebDraft() : ""));
  // Welcome tour (app/Welcome.tsx): opened once on a fresh install, and from
  // the command palette.
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const webSession = useWebPay().session;
  useEffect(() => {
    if (isWeb) writeWebDraft(prompt);
  }, [prompt]);
  const [mode, setModeRaw] = useState<Mode>(isWeb ? "cloud" : "local");
  // The web build has no local engine: every mode switch lands on the cloud.
  const setMode = useCallback((m: Mode) => setModeRaw(isWeb ? "cloud" : m), []);
  // All generations, newest first. Running ones show a live placeholder; done
  // ones stay as images in the grid.
  const [jobs, setJobs] = useState<Job[]>([]);
  // The local engine is single-resident and runs one image at a time, so a model
  // switch must wait for the local queue to drain — restarting the sidecar mid-
  // denoise crashes the in-flight generation. "Active" = something local is
  // running or still queued (drives the "Add to queue" label).
  const localQueueActive = jobs.some(
    (j) => j.kind !== "tool" && j.mode === "local" && !j.hidden && (j.status === "running" || j.status === "queued")
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
      j.kind !== "tool" &&
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
  // LoRAs checked in the LoRA card (local mode). Kept across model switches;
  // only the ones that fit the model actually running are sent.
  const [activeLoras, setActiveLoras] = useState<LoraRef[]>([]);
  // Catalog LoRAs checked in cloud mode (codes; imference resolves the files).
  const [activeCloudLoras, setActiveCloudLoras] = useState<CloudLoraRef[]>([]);
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
  const {
    columns: panelColumns, collapsed: panelCollapsed, widths: panelWidths, hidden: panelHidden,
    setColumns: setPanelColumns, toggleCollapsed: togglePanelCollapsed, setWidths: setPanelWidths,
    setPanelHidden,
  } = usePanelLayout();
  const togglePanel = useCallback(
    (id: PanelId) => setPanelHidden(id, !panelHidden[id]),
    [setPanelHidden, panelHidden]
  );
  // Cmd/Ctrl+1..3 shows / hides Create, Edit, Gallery (same as the header switches).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const p = PANEL_ORDER.find((x) => x.key === e.key);
      if (!p) return;
      e.preventDefault();
      togglePanel(p.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel]);
  // Fullscreen viewer — shared by the gallery and the Activity panel.
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);
  // Command palette (⌘K) + the model-picker open state it drives (lifted here so
  // the palette can open the picker, not just ModelBar's own trigger).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Opened from the payment line and the Activity panel (openCloudHistory).
  useEffect(() => {
    const open = () => setHistoryOpen(true);
    window.addEventListener(OPEN_HISTORY_EVENT, open);
    return () => window.removeEventListener(OPEN_HISTORY_EVENT, open);
  }, []);
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
            if (js[i].status === "running" && js[i].mode === "local" && js[i].kind !== "tool") {
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

  // --- Base components (shared text encoder / VAE / tokenizer repo) --------
  // A transformer-only model can't generate until its base repo is in the
  // offline tree; the readiness check gates Generate and the ModelBar offers
  // an explicit download (progress via components:* events). Readiness is
  // re-checked whenever the selected local model (or its base repo) changes,
  // and after a download completes.
  const [compReadiness, setCompReadiness] = useState<ComponentsReadiness | null>(null);
  const [compProgress, setCompProgress] = useState<ComponentsProgress | null>(null);
  const [compDownloading, setCompDownloading] = useState(false);
  const [compChecking, setCompChecking] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);

  // Follow the model the ModelBar DISPLAYS: the pending pick when there is
  // one, else the saved active model. Keying off settings.localModel alone
  // once showed the previous model's missing components under a freshly
  // selected self-contained SDXL.
  const shownLocalModel = pendingLocalModel ?? settings?.localModel ?? null;
  const activeBaseRepo = shownLocalModel?.baseModel ?? "";
  const activeBackend = shownLocalModel?.backendType ?? "";
  useEffect(() => {
    let alive = true;
    setCompReadiness(null);
    setCompError(null);
    // Always ask, even with no base repo: some backends (SDXL/SD1.5) have
    // AUXILIARY component repos of their own (config repo, fp16-fix VAE) that
    // the Go side resolves per backend — a "self-contained" SDXL once hid a
    // ~340 MB VAE pull behind its first generation.
    if (!shownLocalModel) return;
    setCompChecking(true);
    api
      .checkModelReadiness(activeBaseRepo, activeBackend)
      .then((r) => alive && setCompReadiness(r))
      .catch(() => alive && setCompReadiness(null)) // unknown → don't gate
      .finally(() => alive && setCompChecking(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBaseRepo, activeBackend, shownLocalModel?.modelCode]);

  useEffect(() => {
    const offProgress = api.onComponentsProgress((p) => {
      setCompDownloading(!p.done);
      setCompProgress(p.done ? null : p);
    });
    const offDone = api.onComponentsDone((d) => {
      setCompDownloading(false);
      setCompProgress(null);
      setCompError(null);
      void api
        .checkModelReadiness(d.baseRepo, compBackendRef.current)
        .then(setCompReadiness);
    });
    const offError = api.onComponentsError((d) => {
      setCompDownloading(false);
      setCompProgress(null);
      setCompError(d.error);
    });
    return () => {
      offProgress();
      offDone();
      offError();
    };
  }, []);

  // Mirror the shown backend for the done-handler (subscribed once).
  const compBackendRef = useRef(activeBackend);
  compBackendRef.current = activeBackend;

  const downloadComponents = useCallback(() => {
    setCompError(null);
    setCompDownloading(true);
    api.downloadModelComponents(activeBaseRepo, activeBackend).catch((e) => {
      setCompDownloading(false);
      setCompError(e instanceof Error ? e.message : String(e));
    });
  }, [activeBaseRepo, activeBackend]);

  // Gate: only a POSITIVE "files are missing" verdict blocks — an unknown
  // readiness (no manifest, check failed) falls back to the engine's lazy path.
  const componentsBlocked =
    !!compReadiness && compReadiness.hasManifest && !compReadiness.ready;

  // Open Settings, optionally scrolled to a section (payment-bar deep-links).
  const openSettings = useCallback((section?: string) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  // The payment dialog lives outside App (main.tsx): it asks for Settings at a
  // section, and reports a key it adopted so the settings are read again.
  useEffect(() => {
    const onOpen = (e: Event) => openSettings((e as CustomEvent<string>).detail);
    const onChanged = () => void api.getSettings().then(setSettings).catch(() => {});
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    };
  }, [openSettings]);

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
  // Web: a run is always allowed to start — without a way to pay, the server
  // refuses it and the payment dialog opens (WebPay.tsx).
  const cloudConfigured =
    isWeb || (settings?.paymentMode === "x402" ? walletConfigured : !!settings?.apiKey);
  // Desktop: can the chosen method pay THIS run (set up, and enough on it)?
  // Checked before sending: an empty wallet used to start the run and fail.
  const pay = usePayState(settings, !isWeb && mode === "cloud");
  const cloudRunCost = settings?.cloudModelInfo
    ? runCost(settings.cloudModelInfo, params?.formatCode ?? "", params?.durationS ?? null)
    : 0;
  const cloudPayProblem = isWeb || mode !== "cloud" ? null : payProblem(pay, cloudRunCost);
  const cloudReady = cloudConfigured && !cloudPayProblem && !!settings?.cloudModel;

  // First run: nothing is usable yet (no local engine AND no cloud payment).
  // The Create panel shows a guided setup instead of the (non-functional)
  // composer, unless the user has skipped it.
  // Web: no onboarding — the app opens on the composer, and the first run asks
  // how to pay (WebPay.tsx).
  const firstRun = !isWeb && !engineInstalled && !cloudConfigured && !onboardingSkipped;

  // A fresh install opens the welcome tour once: desktop with nothing set up
  // yet (no engine, no cloud payment; settings and the engine probe known),
  // web with no way to pay yet. Existing users updating never see it.
  const freshInstall = isWeb
    ? !webSession.hasKey && !webSession.payMode
    : settings !== null && !engineInstalled && !cloudConfigured;
  useEffect(() => {
    if (freshInstall && !welcomeDone()) setWelcomeOpen(true);
  }, [freshInstall]);
  const applySamplePrompt = useCallback((p: string) => {
    setPrompt(p);
    window.setTimeout(() => document.getElementById("composer-prompt")?.focus(), 50);
  }, []);

  // Refresh wallet-configured state whenever x402 is (or becomes) the mode, or a
  // wallet is generated/imported (walletAddress changes). Reads the keychain.
  useEffect(() => {
    if (isWeb) return;
    const read = () => void api.getWalletInfo().then((w) => setWalletConfigured(w.configured)).catch(() => {});
    read();
    return onBalanceMaybeChanged(read);
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
  // checkpoints, so a Krea 2 pick — which has no img2img at all — reports 0
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
  const localCanRun =
    engineInstalled && localCached && sidecar.state !== "error" && !componentsBlocked;
  // Instruction-edit models (Qwen-Image-Edit) have no text-to-image mode: they
  // only run through Edit > Edit with instructions. Generate stays disabled and
  // the Create panel says where to go instead of failing in the engine.
  const editModelActive = isEditModel(activeModel);
  // The model "Switch back" restores, by name (settings keeps its code).
  const [previousModelName, setPreviousModelName] = useState("");
  useEffect(() => {
    if (!editModelActive || !settings?.previousLocalModel) return;
    let alive = true;
    void api
      .listEditModels()
      .then((m) => alive && setPreviousModelName(m.previous?.name ?? ""))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [editModelActive, settings?.previousLocalModel]);
  const canGenerate =
    (mode === "cloud" ? cloudReady : localCanRun) && !!prompt.trim() && !editModelActive;

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
        if (result.source === "cloud") notifyBalanceChanged();
      })
      .catch((e) => {
        // User-stopped run: the sidecar was killed out from under it. Hide the
        // row silently — it's a cancel, not a failure.
        if (cancelledIdsRef.current.has(id)) {
          cancelledIdsRef.current.delete(id);
          setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "error", hidden: true } : j)));
          return;
        }
        // Payment failures in plain words (not enough credits, no wallet…).
        const msg = friendlyPayError(t, e instanceof Error ? e.message : String(e));
        setJobs((js) =>
          js.map((j) => (j.id === id ? { ...j, status: "error", error: msg, endedAt: Date.now() } : j))
        );
        // No toast: the Activity widget pops a finish notice for it.
      });
  }, [toast, t]);

  // Settle a RESUMED cloud job (one that was interrupted by a prior app close
  // and reclaimed by the Go side). Arrives via the "cloud:resolved" event, not a
  // promise. Updates the hydrated Activity row, or adds one if the result landed
  // before its row was hydrated.
  const applyCloudResolved = useCallback((r: CloudResolved) => {
    if (r.result) notifyBalanceChanged(); // a resumed run was paid
    setJobs((js) => {
      const exists = js.some((j) => j.id === r.jobId);
      if (r.error) {
        if (!exists) return js;
        return js.map((j) =>
          j.id === r.jobId ? { ...j, status: "error", error: (r.error ? friendlyPayError(t, r.error) : r.error), endedAt: Date.now() } : j
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
        // 0 = unspecified. Both are omitempty all the way to the worker, so a
        // model with no such knob simply never receives the field. Clamped to
        // the catalog's bounds on the way out: the controls respect them, but a
        // value can also come from a param set carried over from another model,
        // and the worker is the one that pays for an out-of-range step count.
        numSteps: clampToCatalog(pr?.steps ?? 0, model?.stepsMin, model?.stepsMax),
        guidanceScale: clampToCatalog(pr?.cfg ?? 0, model?.cfgMin, model?.cfgMax),
      };
      if (pr?.negativePrompt) req.negativePrompt = pr.negativePrompt;
      if (pr && pr.seedMode === "fixed") req.seed = pr.seed;
      // Clip length: cloud video models that publish bounds. The server clamps
      // it and drops it for models that take none, but don't send what the
      // model never offered in the first place.
      if (which === "cloud" && model?.durationDefault != null && pr?.durationS != null) {
        req.durationS = pr.durationS;
      }
      // The chosen format drives the cloud price (credit_multiplier); without it
      // the server has to infer it from width×height. Custom dims have no
      // catalog format, so nothing is claimed for them.
      if (which === "cloud" && pr && pr.formatCode && pr.formatCode !== CUSTOM_FORMAT) {
        req.formatCode = pr.formatCode;
      }
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
      // LoRAs: local only, and only those that still fit the model's family.
      const backend = model?.backendType ?? "";
      if (which === "local" && LORA_BACKENDS.has(backend)) {
        const library = settings?.loras ?? [];
        const loras = activeLoras.filter((a) =>
          library.some((l) => l.path === a.path && loraFits(l, backend, model?.familyCode))
        );
        if (loras.length > 0) req.loras = loras;
      }
      if (which === "cloud" && LORA_BACKENDS.has(backend) && activeCloudLoras.length > 0) {
        req.cloudLoras = activeCloudLoras;
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
    [prompt, pendingLocalModel, settings?.localModel, settings?.cloudModelInfo, settings?.loras, params, refImages, refSlots, strength, activeLoras, activeCloudLoras, settleJob]
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
    if (jobs.some((j) => j.kind !== "tool" && j.mode === "local" && j.status === "running" && !j.hidden)) return;
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
      // A tool run: cancel it (the tools sidecar / cloud poll stop; nothing to reload).
      if (job.kind === "tool") {
        if (job.status === "running") void api.cancelTool(job.id).catch(() => {});
        else if (job.status === "queued") dismissJob(job.id);
        return;
      }
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

  // --- Edit panel ------------------------------------------------------------
  // The item open in the Edit panel (null = panel hidden), and the gallery
  // files tool runs wrote (the gallery pulls them in).
  const [editTarget, setEditTarget] = useState<{
    toolId: string;
    source: ToolSource;
    maskMode?: "select";
    key: number;
  } | null>(null);
  const [toolOutputs, setToolOutputs] = useState<string[]>([]);
  // Show a panel, bring it into view and flash it so the eye lands on it.
  const flashPanel = useCallback(
    (id: PanelId) => {
      setPanelHidden(id, false);
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        el.classList.add("panel-flash");
        window.setTimeout(() => el.classList.remove("panel-flash"), 1200);
      }, 60);
    },
    [setPanelHidden]
  );
  const openEditor = useCallback(
    (toolId: string, source: ToolSource, maskMode?: "select") => {
      setEditTarget({ toolId, source, maskMode, key: Date.now() });
      setPanelHidden("edit", false);
      flashPanel("edit");
    },
    [setPanelHidden, flashPanel]
  );

  // Tool stages ("tools:progress") onto their Activity rows.
  useEffect(
    () =>
      api.onToolProgress((p) =>
        setJobs((js) =>
          js.some((j) => j.id === p.jobId && j.kind === "tool")
            ? js.map((j) =>
                j.id === p.jobId && j.tool ? { ...j, tool: { ...j.tool, stage: p.stage, fraction: p.fraction } } : j
              )
            : js
        )
      ),
    []
  );

  // Runs an AI agent starts through the local API ("agent:run"): an Activity
  // row "via Claude" while it runs, then its image joins the gallery like any
  // local run (a tool's outputs too). A final event without a row (the app
  // opened mid-run) adds the row directly.
  useEffect(
    () =>
      api.onAgentRun((r) => {
        const isTool = r.kind === "tool";
        const now = Date.now();
        const base: Job = {
          id: r.jobId, mode: r.mode === "cloud" ? "cloud" : "local", prompt: r.label, status: "running", progress: null,
          queuedAt: now, startedAt: now, via: r.agent ?? "", modelName: r.model || undefined,
          ...(isTool ? { kind: "tool" as const, tool: { toolId: r.toolId ?? "" } } : {}),
        };
        const upsert = (patch: (j: Job) => Partial<Job>) =>
          setJobs((js) =>
            js.some((j) => j.id === r.jobId)
              ? js.map((j) => (j.id === r.jobId ? { ...j, ...patch(j) } : j))
              : [{ ...base, ...patch(base) }, ...js]
          );
        if (r.state === "running") {
          upsert(() => ({}));
          return;
        }
        if (r.state === "error") {
          upsert((j) => ({ status: "error", error: r.error ?? "", endedAt: Date.now(), ...(j.tool ? { tool: { ...j.tool, stage: undefined } } : {}) }));
          return;
        }
        if (!isTool) {
          upsert((j) => ({ status: "done", image: r.image, progress: null, endedAt: Date.now(), modelName: r.model || j.modelName }));
          return;
        }
        const res = r.tool;
        const saved = res?.outputs.map((o) => o.savedName).filter((n): n is string => !!n) ?? [];
        const first = res?.outputs.find((o) => o.savedName && o.type !== "text");
        void (first?.savedName ? api.getSavedImage(first.savedName).catch(() => undefined) : Promise.resolve(undefined)).then(
          (preview) => {
            upsert((j) => ({ status: "done", endedAt: Date.now(), tool: { ...(j.tool ?? { toolId: r.toolId ?? "" }), result: res, preview, stage: undefined } }));
            if (saved.length) setToolOutputs((o) => [...o, ...saved]);
          }
        );
      }),
    []
  );

  // A tool run is an Activity job, like a generation: cloud runs start at
  // once (in parallel), local runs wait in their own queue and run one at a
  // time (one engine). The result lands in the gallery; the Edit panel never
  // waits for it.
  const execToolJob = useCallback(
    (req: ToolRunRequest, label: string) => {
      setJobs((js) =>
        js.map((j) => (j.id === req.jobId ? { ...j, status: "running", startedAt: Date.now() } : j))
      );
      const settle = (patch: (j: Job) => Partial<Job>) =>
        setJobs((js) => js.map((j) => (j.id === req.jobId ? { ...j, ...patch(j), endedAt: Date.now() } : j)));
      void api
        .runTool(req)
        .catch(
          (e: unknown): ToolRunResult => ({
            jobId: req.jobId, toolId: req.toolId, outputs: [], durationMs: 0,
            error: { code: "internal", message: e instanceof Error ? e.message : String(e) },
          })
        )
        .then(async (res) => {
          const mode = res.ranOn === "cloud" ? ("cloud" as const) : ("local" as const);
          if (res.error) {
            const cancelled = res.error.code === "cancelled";
            settle((j) => ({
              status: "error", error: friendlyPayError(t, res.error!.message), hidden: cancelled || j.hidden, mode,
              tool: { ...j.tool!, result: res, stage: undefined },
            }));
            return;
          }
          const saved = res.outputs.map((o) => o.savedName).filter((n): n is string => !!n);
          const first = res.outputs.find((o) => o.savedName && o.type !== "text");
          const preview = first?.savedName ? await api.getSavedImage(first.savedName).catch(() => undefined) : undefined;
          settle((j) => ({ status: "done", mode, tool: { ...j.tool!, result: res, preview, stage: undefined } }));
          if (mode === "cloud") notifyBalanceChanged(); // a paid run: balances moved
          // Its weights are on disk now: the panels stop announcing the download.
          if (mode === "local") void refreshTools().catch(() => {});
          if (saved.length) setToolOutputs((o) => [...o, ...saved]);
        });
    },
    [toast, t]
  );

  const runToolJob = useCallback(
    (req: ToolRunRequest, label: string, sourceName: string | null) => {
      const now = Date.now();
      const cloud = req.runOn === "cloud";
      setJobs((js) => [
        {
          id: req.jobId, kind: "tool", mode: cloud ? "cloud" : "local", prompt: label,
          status: "queued", progress: null, queuedAt: now,
          tool: { toolId: req.toolId, sourceName, request: req },
        },
        ...js,
      ]);
      if (cloud) {
        startedToolsRef.current.add(req.jobId);
        execToolJob(req, label);
      }
    },
    [execToolJob]
  );

  // Local tool queue: start the oldest waiting local run when none is running.
  // startedToolsRef guards against starting one twice before its "running"
  // status is rendered.
  const startedToolsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = (j: Job) => j.kind === "tool" && j.mode === "local" && !j.hidden;
    if (jobs.some((j) => live(j) && j.status === "running")) return;
    let next: Job | undefined;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (live(jobs[i]) && jobs[i].status === "queued") {
        next = jobs[i];
        break;
      }
    }
    if (!next?.tool?.request || startedToolsRef.current.has(next.id)) return;
    startedToolsRef.current.add(next.id);
    execToolJob(next.tool.request, next.prompt);
  }, [jobs, execToolJob]);

  // --- Gallery → composer bridges ------------------------------------------
  // Send an image into the img2img source and switch to local (img2img is
  // local-only). Used by the gallery context menu and by dropping onto the panel.
  const useAsImg2img = useCallback(async (getSrc: () => Promise<string>) => {
    try {
      const src = await getSrc();
      // A video can't seed img2img — ignore the gesture (the lightbox/menu also
      // hide the action for videos; this guards the drag path).
      if (!src || isVideoSrc(src)) return;
      // The selected model takes no reference image (a Krea 2 pick, say): the
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
  const [editDropActive, setEditDropActive] = useState(false);
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
    (e: React.PointerEvent, getSrc: () => Promise<string>, previewSrc: string | null, name?: string | null) => {
      const sx = e.clientX, sy = e.clientY;
      const overCreate = (x: number, y: number) =>
        !!document.elementFromPoint(x, y)?.closest(".create-surface");
      // The empty Edit panel takes a dropped tile too (opens it in the editor).
      const overEdit = (x: number, y: number) =>
        !!document.elementFromPoint(x, y)?.closest(".edit-drop-surface");
      beginPointerDrag(e, {
        onStart: () => setImageDrag({ src: previewSrc, x: sx, y: sy }),
        onMove: (x, y) => {
          setImageDrag((d) => (d ? { ...d, x, y } : d));
          setDropActive(overCreate(x, y));
          setEditDropActive(overEdit(x, y));
        },
        onEnd: (x, y, moved) => {
          if (!moved) return;
          tileClickGuard.suppressed = true;
          window.setTimeout(() => { tileClickGuard.suppressed = false; }, 0);
          const drop = overCreate(x, y);
          const toEdit = overEdit(x, y);
          setImageDrag(null);
          setDropActive(false);
          setEditDropActive(false);
          if (drop) void useAsImg2img(getSrc);
          else if (toEdit) openEditor(defaultToolFor("image"), { name: name ?? null, kind: "image", getSrc });
        },
      });
    },
    [useAsImg2img, openEditor]
  );

  // Primary button: in local mode it only asks for a click of its own when the
  // weights aren't on disk (a multi-GB download is never implicit). Weights
  // already cached → it stays Generate / Add to queue, and swapping them into
  // the engine rides along with the run. Cmd/Ctrl+Enter triggers whichever is
  // current.
  // The primary button is ALWAYS Generate now — downloads and engine
  // lifecycle live in the LocalReadinessCard, never behind this label.
  const contextHintRef = useRef("");
  const primary: ComposerAction = useMemo(() => {
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
          if (settings?.localModel?.modelCode === pendingLocalModel.modelCode) {
            // The custom checkpoint is ALREADY the registered model — the
            // engine is just down. useCustomModel only restarts a RUNNING
            // sidecar, so re-registering here left the queued job stuck on
            // "next up" forever; a plain start loads it.
            void api.startSidecar().catch(() => {});
          } else {
            // User checkpoint: no cache index, its own activation path.
            void selectCustomModel(pendingLocalModel).catch(() => {});
          }
        } else {
          activateLocalModel(true);
        }
      },
      disabled: !canGenerate,
      busy: false,
      kind: "generate",
      onBlocked: () => {
        const b: Blocker[] = [];
        if (editModelActive) b.push("edit-model");
        else if (mode === "cloud") {
          if (!cloudConfigured || cloudPayProblem) {
            b.push("payment");
            // Open the fix right away: buy / top up credits, or the wallet.
            if (pay.method === "bearer")
              void openPayDialog(cloudPayProblem === "short" ? "insufficient_credits" : "needs_key");
            else openSettings("wallet");
          } else if (!settings?.cloudModel) b.push("model");
        } else if (!localCanRun) {
          b.push(pendingLocalModel || settings?.localModel ? "readiness" : "model");
        }
        if (!prompt.trim()) b.push("prompt");
        flagBlockers(b);
        toast.toast(b[0] === "prompt" ? t("hint.writePrompt") : contextHintRef.current);
      },
    };
  }, [editModelActive, cloudConfigured, cloudPayProblem, pay.method, openSettings, settings?.cloudModel, localCanRun, prompt, toast, mode, localNeedsActivation, pendingSwitch, pendingLocalModel, settings?.localModel?.modelCode, activateLocalModel, selectCustomModel, canGenerate, localQueueActive, run, t]);

  // Global ⌘/Ctrl+Enter → run the primary action from anywhere in the app, not
  // only when the prompt field has focus. Suppressed while a modal that captures
  // typing is open (palette, settings, model picker, custom-model, lightbox), and
  // preventDefault still swallows the newline when focus IS in the prompt. A ref
  // holds the latest action/guards so the listener subscribes just once.
  const primaryHotkeyRef = useRef<{ disabled: boolean; onClick: () => void; onBlocked?: () => void; blocked: boolean }>({
    disabled: true,
    onClick: () => {},
    blocked: false,
  });
  primaryHotkeyRef.current = {
    disabled: primary.disabled,
    onClick: primary.onClick,
    onBlocked: primary.onBlocked,
    blocked: paletteOpen || shortcutsOpen || historyOpen || settingsOpen || modelPickerOpen || !!customModelPath || !!lightbox,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const s = primaryHotkeyRef.current;
        if (s.blocked) return;
        e.preventDefault();
        if (s.disabled) s.onBlocked?.();
        else s.onClick();
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
    if (editModelActive) return t("hint.editModel");
    if (mode === "cloud") {
      if (cloudPayProblem === "short")
        return t(pay.method === "x402" ? "hint.notEnoughUsdc" : "hint.notEnoughCredits");
      if (!cloudConfigured || cloudPayProblem) return t("hint.configurePayment");
      const c = settings?.cloudModelInfo;
      if (!c) return t("hint.pickCloudModel");
      if (!(c.cost > 0)) return c.name;
      // Not the model's base price: the format and the clip length scale it,
      // and this must match what the server bills to the credit (runCost).
      const cost = runCost(c, params?.formatCode ?? "", params?.durationS ?? null);
      // x402 pays in on-chain USDC; bearer pays in credits — show the matching unit.
      return settings?.paymentMode === "x402"
        ? t("hint.usdPerRun", { name: c.name, usd: creditsToUSD(cost) })
        : t("hint.creditsPerRun", { name: c.name, cost });
    }
    if (!engineInstalled) return t("hint.engineNotInstalled");
    if (downloading) return activationIsLoad ? t("hint.loadingModel") : t("hint.downloadingModel");
    if (localNeedsDownload) return t("hint.clickDownload", { name: pendingLocalModel?.name });
    if (sidecar.state === "error") return t("hint.engineError");
    // Cached but not resident: generating loads it first, so say that rather
    // than sending the user off to the engine control.
    // Components before the activation hint: a cached-but-unloaded model whose
    // shared base is missing must say "download components", not "will load" —
    // generating would gate on the components either way.
    if (componentsBlocked) return t("hint.downloadComponents");
    if (localNeedsActivation) return t("hint.willLoad", { name: pendingLocalModel?.name });
    if (sidecar.state === "starting") return t("hint.engineStarting");
    if (sidecar.state !== "ready") return t("hint.startEngine");
    return settings?.localModel?.name ?? t("hint.pickModel");
  }, [editModelActive, mode, cloudConfigured, cloudPayProblem, pay.method, downloading, activationIsLoad, localNeedsDownload, localNeedsActivation, componentsBlocked, pendingLocalModel, sidecar.state, settings?.cloudModelInfo, settings?.localModel, settings?.paymentMode, params?.formatCode, params?.durationS, engineInstalled, t]);
  contextHintRef.current = contextHint;

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
  const doneJobs = useMemo(() => jobs.filter((j) => j.status === "done" && !j.hidden && j.kind !== "tool"), [jobs]);

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

    for (const p of PANEL_ORDER) {
      const name = t(`panels.${p.id}`);
      cmds.push({
        id: `panel-${p.id}`, group: gApp,
        label: t(panelHidden[p.id] ? "panels.show" : "panels.hide", { name }),
        icon: <PanelIcon id={p.id} />, keywords: "panel view layout toggle",
        shortcut: [modLabel, p.key], run: () => togglePanel(p.id),
      });
    }
    cmds.push({ id: "settings", group: gApp, label: t("palette.settings"), icon: <Settings />, keywords: "preferences", run: () => openSettings() });
    cmds.push({ id: "logs", group: gApp, label: t("palette.logs"), icon: <ScrollText />, keywords: "console debug", run: () => setLogsOpen((o) => !o) });
    cmds.push({ id: "history", group: gApp, label: t("history.title"), icon: <History />, keywords: "history calls past cloud download redownload api key wallet", run: () => setHistoryOpen(true) });
    cmds.push({ id: "shortcuts", group: gApp, label: t("shortcuts.title"), icon: <Keyboard />, keywords: "keyboard keys help", run: () => setShortcutsOpen(true) });
    cmds.push({ id: "welcome", group: gApp, label: t("palette.welcome"), icon: <Sparkles />, keywords: "welcome tour onboarding help start guide", run: () => setWelcomeOpen(true) });

    return cmds;
  }, [
    t, canGenerate, primary, mode, engineInstalled, sidecar.state, settings?.localModel,
    installEngine, stopEngine, startEngine,
    hasFinished, clearFinished, openSettings, panelHidden, togglePanel
  ]);

  // The engine block — payment, model, local readiness, a held model switch —
  // at the top of Create. The mode itself lives in the header (one switch),
  // and the machine's details in the header's engine popover.
  const engineBlock = (
    <>
      {/* 1. Model — with, in the cloud, how it is paid on the same card. */}
      {!firstRun && (
        <div data-blocker="model" className="rounded-2xl">
        <ModelBar
          mode={mode}
          settings={settings}
          onModelSwitched={handleSettingsSaved}
          pendingLocalModel={pendingLocalModel}
          onSelectLocal={setPendingLocalModel}
          cachedCodes={cachedCodes}
          downloading={downloading}
          onAddCustom={addCustomModel}
          onSelectCustom={selectCustomModel}
          onRemoveCustom={removeCustomModel}
          pickerOpen={modelPickerOpen}
          onPickerOpenChange={setModelPickerOpen}
          engineModel={settings?.localModel}
          engineState={sidecar.state}
          selectionCached={localCached}
          onLoadNow={() => activateLocalModel(true)}
          footer={
            !isWeb && mode === "cloud" ? (
              <div data-blocker="payment" className="rounded-lg">
                <PaymentBar settings={settings} pay={pay} costCredits={cloudRunCost} onModeChange={setPaymentMode} onConfigure={openSettings} />
              </div>
            ) : isWeb ? (
              <div data-blocker="payment" className="rounded-lg">
                <WebPaymentBar onConfigure={openSettings} />
              </div>
            ) : undefined
          }
        />
        </div>
      )}

      {/* 2b. Local readiness — the ONE preflight panel: weights,
          shared components, engine. Every action that used to be
          scattered (header start, under-model download, Generate
          hijacked into a downloader) lives here. */}
      {!firstRun && mode === "local" && (
        <div data-blocker="readiness" className="rounded-2xl">
        <LocalReadinessCard
          model={pendingLocalModel}
          engineInstalled={engineInstalled}
          installing={installing}
          sidecar={sidecar}
          onInstallEngine={installEngine}
          onStartEngine={startEngine}
          onStopEngine={stopEngine}
          weightsCached={localCached}
          weightsDownloading={downloading}
          weightsIsLoad={activationIsLoad}
          weightsProgress={dlProgress}
          onDownloadWeights={downloadLocalModel}
          onCancelWeights={cancelDownload}
          componentsReadiness={compReadiness}
          componentsProgress={compProgress}
          componentsDownloading={compDownloading}
          componentsChecking={compChecking}
          componentsError={compError}
          onDownloadComponents={downloadComponents}
        />
        </div>
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
    </>
  );

  return (
    // The whole window takes the global mode's tint (app-frame + aurora):
    // you should never need to look at the switch to know where a run goes.
    <div className="app-frame relative flex h-full flex-col overflow-hidden" data-mode={mode}>
      <div className="aurora" aria-hidden="true" data-mode={mode}>
        <span className="aurora-blob aurora-blob-1" />
        <span className="aurora-blob aurora-blob-2" />
        <span className="aurora-blob aurora-blob-3" />
      </div>
      {isWeb && <WebPayNotice />}
      {isWeb && <WebGalleryBanner />}
      <Header
        appVersion={appVersion}
        sidecar={sidecar}
        engineInstalled={engineInstalled}
        installing={installing}
        hasLocalModel={!!settings?.localModel}
        engineModel={settings?.localModel}
        loraCount={activeLoras.length}
        onInstallEngine={installEngine}
        onStartEngine={startEngine}
        onStopEngine={stopEngine}
        onSelectModel={() => setMode("local")}
        errorLogCount={errorLogCount}
        onToggleLogs={() => setLogsOpen((o) => !o)}
        onOpenSettings={() => openSettings()}
        onOpenAgents={() => openSettings("agents")}
        onOpenPalette={() => setPaletteOpen(true)}
        panelHidden={panelHidden}
        onTogglePanel={togglePanel}
        mode={mode}
        onModeChange={setMode}
      />
      {/* The global mode, as a thin accent under the header. */}
      <div className="mode-accent relative z-10" data-mode={mode} aria-hidden="true" />

      {updateInfo?.updateAvailable && updateInfo.latestVersion && (
        <div className="relative z-10 mx-auto w-full max-w-[110rem] px-4 pt-4 sm:px-6">
          <UpdateBanner info={updateInfo} onDismiss={dismissUpdate} />
        </div>
      )}

      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden xl:overflow-hidden">
        <h1 className="sr-only">{isWeb ? "Imference Web" : "Imference Desktop"}</h1>
        {/* Three drag-reorderable panels — Create / Activity / Gallery — side by
            side on desktop, stacked (in the same order) on narrow windows. */}
        <div className="mx-auto w-full max-w-[110rem] px-4 pt-5 pb-16 sm:px-6 xl:flex xl:h-full xl:flex-col xl:pb-0">
          <PanelBoard
            columns={visibleColumns(panelColumns, panelHidden)}
            onColumnsChange={(next) => setPanelColumns(restoreHidden(next, panelColumns, panelHidden))}
            collapsed={panelCollapsed}
            onToggleCollapsed={togglePanelCollapsed}
            widths={panelWidths}
            onWidthsChange={setPanelWidths}
            panels={{
              create: {
                title: t("panels.create"),
                icon: <Wand2 />,
                width: 24,
                content: (
                  // Mode-tinted surface: the panel is felt in the active mode's
                  // accent. Its column scrolls (PanelBoard), so a long open
                  // Parameters section stays reachable.
                  <div
                    className={cn(
                      // max-h leaves a bottom gap: the surface starts ~118px down
                      // (topbar + panel header + sticky top-4), so subtract that
                      // plus breathing room — otherwise the last card (Parameters)
                      // sits flush against / just under the window edge.
                      // scrollbar-gutter:stable reserves the scrollbar its own lane
                      // beyond the right padding, so it never clips the cards'
                      // rounded corners (Windows/WebView2 shows a wide scrollbar).
                      "create-surface relative flex flex-col gap-3 pb-4",
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
                    {/* Where it runs: payment, model, local readiness. */}
                    {engineBlock}

                    {/* An edit model is loaded: say so first, it blocks Generate. */}
                    {editModelActive && (
                      <div
                        role="note"
                        data-blocker="edit-model"
                        className="ds-callout ds-callout-warning flex gap-2 p-3 text-xs leading-relaxed"
                      >
                        <Wand2 className="mt-0.5 size-4 shrink-0" />
                        <div className="space-y-2">
                          <p>{t("hint.editModelLong")}</p>
                          {mode === "local" && settings?.previousLocalModel && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void api.switchBackFromEditModel().catch(() => {})}
                            >
                              {t("tools.instruct.switchBack", { name: previousModelName || settings.previousLocalModel })}
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    {firstRun ? (
                      /* First run: a guided setup replaces the (non-functional)
                         composer until the engine is installed or cloud is set up. */
                      <FirstRunSetup
                        onInstallDone={() => void api.getSettings().then(setSettings)}
                        onOpenCloudSettings={() => void openPayDialog("needs_key")}
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

                        {/* 3. Optional inputs — reference images and LoRAs —
                            joined into one card (.ds-stack), a hairline apart. */}
                        {(refSlots > 0 || (!!activeModel && LORA_BACKENDS.has(activeModel.backendType ?? ""))) && (
                        <div className="ds-stack">
                        {refSlots > 0 && (
                          <RefImageCard
                            slots={refSlots}
                            images={refImages}
                            onImagesChange={setRefImages}
                            targetW={refDims.width}
                            targetH={refDims.height}
                            strength={strength}
                            onStrengthChange={setStrength}
                            showStrength={!(mode === "cloud" && (activeModel?.external || activeModel?.modelType === "video"))}
                          />
                        )}

                        {/* 3c. LoRAs — catalog LoRAs in cloud mode (applied by imference). */}
                        {mode === "cloud" && activeModel && LORA_BACKENDS.has(activeModel.backendType ?? "") && (
                          <CloudLoraCard
                            backend={activeModel.backendType ?? ""}
                            modelCode={activeModel.modelCode}
                            familyCode={activeModel.familyCode}
                            active={activeCloudLoras}
                            onActiveChange={setActiveCloudLoras}
                            onInsertTrigger={(word) =>
                              setPrompt((p) =>
                                p.toLowerCase().includes(word.toLowerCase()) ? p : p.trim() ? `${word}, ${p}` : word
                              )
                            }
                          />
                        )}

                        {/* 3c. LoRAs — local mode, LoRA-capable backends only. */}
                        {mode === "local" && activeModel && LORA_BACKENDS.has(activeModel.backendType ?? "") && (
                          <LoraCard
                            backend={activeModel.backendType ?? ""}
                            modelCode={activeModel.modelCode}
                            familyCode={activeModel.familyCode}
                            library={settings?.loras ?? []}
                            active={activeLoras}
                            onActiveChange={setActiveLoras}
                            onSettingsChange={setSettings}
                            onInsertTrigger={(word) =>
                              setPrompt((p) =>
                                p.toLowerCase().includes(word.toLowerCase())
                                  ? p
                                  : p.trim()
                                    ? `${word}, ${p}`
                                    : word
                              )
                            }
                          />
                        )}

                        </div>
                        )}

                        {/* 4. Format, then the fine-tuning Parameters — one card. */}
                        {activeModel && params && (
                        <div className="ds-stack">
                          <FormatSelector
                            model={activeModel}
                            mode={mode}
                            params={params}
                            onChange={(patch) => setParams((pp) => (pp ? { ...pp, ...patch } : pp))}
                          />
                          <ParamsPanel model={activeModel} mode={mode} params={params} onChange={setParams} />
                        </div>
                        )}

                        {/* 6. The run button — last in the panel, but pinned to
                            the bottom of the viewport so it never scrolls away. */}
                        <PrimaryAction action={primary} contextHint={contextHint} mode={mode} />
                      </>
                    )}
                  </div>
                ),
              },
              edit: {
                title: t("panels.edit"),
                icon: <Brush />,
                width: 34,
                content: editTarget ? (
                  <ToolEditor
                    key={editTarget.key}
                    toolId={editTarget.toolId}
                    source={editTarget.source}
                    initialMaskMode={editTarget.maskMode}
                    jobs={jobs}
                    onClose={() => setEditTarget(null)}
                    onRunJob={runToolJob}
                    mode={mode}
                  />
                ) : (
                  <EditEmpty
                    dropActive={editDropActive}
                    galleryHidden={!!panelHidden.gallery}
                    onShowGallery={() => setPanelHidden("gallery", false)}
                    onOpen={(src) => openEditor(defaultToolFor(src.kind), src)}
                  />
                ),
              },
              gallery: {
                title: t("panels.gallery"),
                icon: <Images />,
                grow: true,
                content: (
                  <Gallery
                    jobs={doneJobs}
                    toolOutputs={toolOutputs}
                    onOpenTool={openEditor}
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
      <Welcome
        open={welcomeOpen}
        onOpenChange={setWelcomeOpen}
        mode={mode}
        onModeChange={setMode}
        engineInstalled={engineInstalled}
        onInstallDone={() => void api.getSettings().then(setSettings)}
        onOpenCloudSettings={() => void openPayDialog("needs_key")}
        onUsePrompt={applySamplePrompt}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <CloudHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  );
}
