// Mirrors internal/types/types.go. Once `wails dev` has run once we *could*
// instead `import type { main } from "../../wailsjs/go/models"` for the
// generated equivalents, but those bindings don't exist until first build
// and this keeps the renderer typecheck self-contained.

export type AppSettings = {
  apiKey: string;
  pythonPath: string;
  sdxlPath: string;
  cloudModel: string;
  /** Optional override for the auto-save directory. Empty → Go default (~/Pictures/Imference). */
  outputDir: string;
  /** "bearer" (default, uses apiKey) or "x402" (uses local wallet on Base mainnet). */
  paymentMode: PaymentMode;
  /** Mirror of the configured wallet's public address. Private key lives in OS keychain. */
  walletAddress: string;
  /** Currently-selected local model (downloaded to sdxlPath). Null until chosen. */
  localModel?: ModelInfo | null;
  /** Host-machine tuning for the engine (device, VAE mode, offload, residency caps, WAN quant). */
  engineRuntime?: EngineRuntimeSettings;
  /** Full catalog entry for the selected cloud model (cloudModel holds its code).
   *  Drives the form selector's details + cloud generation params. Null until chosen. */
  cloudModelInfo?: ModelInfo | null;
  /** User-supplied checkpoints (localPath set), referenced in place. */
  customModels?: ModelInfo[];
};

/** Result of api.checkForUpdate(): this build vs the latest GitHub release. */
export type UpdateInfo = {
  /** "dev" (local build) or "X.X.X". */
  currentVersion: string;
  /** Latest release tag without the leading v. */
  latestVersion?: string;
  /** Release page URL to open in the system browser. */
  url?: string;
  updateAvailable: boolean;
};

/**
 * Host-tuning knobs for the active image backend (shared IMAGE_* env contract).
 * All image backends (SDXL, SD 1.5, Z-Image, FLUX, Chroma, Qwen-Image, Anima)
 * share this one block — only one loads per sidecar. useTinyVae only affects
 * SDXL / SD 1.5; the engine ignores it for the others.
 */
export type ImageRuntimeSettings = {
  /**
   * "" / "auto" | cuda | cuda:N | mps | cpu. "cuda" covers both NVIDIA and
   * AMD GPUs (torch's ROCm build presents AMD under the cuda device string).
   */
  device?: string;
  /** SDXL / SD 1.5 TAESD — faster VAE decode, slight quality loss. */
  useTinyVae?: boolean;
  /**
   * Tri-state CPU offload. undefined = Auto (the desktop enables it on
   * low-VRAM GPUs to avoid VRAM oversubscription); true = force on;
   * false = force off. Maps to the Go *bool.
   */
  enableCpuOffload?: boolean;
  /** "" / "auto" / integer */
  maxGpuModels?: string;
  maxCpuModels?: string;
};

/** Host-tuning knobs for the WAN video backend (WAN_* env contract). */
export type WanRuntimeSettings = {
  device?: string;
  /** "" / "auto" | gguf_q8 | gguf_q6 | gguf_q5 | gguf_q4 */
  memoryProfile?: string;
  /** "" / int8 | none */
  textEncoderQuant?: string;
  /** Engine default true. */
  vaeTiling?: boolean;
  /** Engine default true. */
  enableOffload?: boolean;
  maxResident?: string;
};

export type EngineRuntimeSettings = {
  image: ImageRuntimeSettings;
  wan: WanRuntimeSettings;
};

/** One locally-runnable model from the imference catalog (GET /api/models). */
export type ModelInfo = {
  modelCode: string;
  name: string;
  shortDescription: string;
  mediumDescription: string;
  image: string;
  modelUrl: string;
  /** Absolute path of a user-supplied checkpoint. Non-empty = custom model. */
  localPath?: string;
  promptPre: string;
  promptNegative: string;
  stepsDefault: number;
  stepsMin: number;
  stepsMax: number;
  cfgDefault: number;
  cfgMin: number;
  cfgMax: number;
  skipDefault: number;
  schedulerDefault: string;
  formatCode: string;
  /** Engine backend: "sdxl" (default) or "zimage". Empty treated as "sdxl". */
  backendType?: string;
  /** HF repo id of shared base-components (Z-Image), e.g. "Tongyi-MAI/Z-Image-Turbo". */
  baseModel?: string;
  /** Z-Image flow-matching shift (3.0≈480p, 5.0≈720p). Ignored by SDXL. */
  shiftDefault?: number;
  /** Cloud run cost in credits (1 credit = $0.001). Local runs are free. */
  cost: number;
  /** Where the model may run — drives which catalog (local/cloud) lists it. */
  canLocal: boolean;
  canCloud: boolean;
  /** Supported resolutions/ratios (im_format). Empty → generic fallback. */
  formats?: FormatOption[];
  /** Catalog organization (im_model family/group) for sorting/grouping. */
  order?: number;
  familyCode?: string;
  familyName?: string;
  groupCode?: string;
};

/** One supported resolution/ratio for a model (from im_format). */
export type FormatOption = {
  formatCode: string;
  name?: string;
  width: number;
  height: number;
  ratio?: string;
  isDefault: boolean;
};

export type PaymentMode = "bearer" | "x402";

export type WalletInfo = {
  configured: boolean;
  address: string;
  balanceUSDC: string;
  network: string;
  error?: string;
};

export type CreditInfo = {
  configured: boolean;
  credits: number;
  error?: string;
};

export type GenerationRequest = {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  numSteps: number;
  guidanceScale: number;
  seed?: number;
  /** Usually injected server-side from the selected model; optional override. */
  scheduler?: string;
  clipSkip?: number;
  /** img2img: base64 (data-URL ok) source image to denoise from. Empty/undefined = text2img. */
  sourceImage?: string;
  /** img2img denoising strength 0–1 (0 keeps source, 1 ignores it). Only with sourceImage. */
  strength?: number;
};

/** Per-step local generation progress, from the "generate:progress" event. */
export type GenerateProgress = {
  step: number;
  total: number;
  percent: number;
};

/** A previously-generated image found on disk (the output folder gallery). */
export type SavedImage = {
  /** File name — key for api.getSavedImage(name) / api.deleteSavedImage(name). */
  name: string;
  source: string;
  seed: number;
  savedPath: string;
  /** Pixel dimensions (0 when unknown) — used to reserve the masonry tile's box. */
  width: number;
  height: number;
  /** Generation metadata from the sidecar JSON. Absent for pre-feature images. */
  meta?: GenerationMeta | null;
};

/** How an image was generated — from the "<image>.json" sidecar. */
export type GenerationMeta = {
  prompt: string;
  negativePrompt?: string;
  source: string;
  modelCode?: string;
  modelName?: string;
  engine?: string;
  width?: number;
  height?: number;
  formatCode?: string;
  numSteps?: number;
  guidanceScale?: number;
  scheduler?: string;
  clipSkip?: number;
  seed: number;
  img2img?: boolean;
  strength?: number;
  createdAt: string;
};

export type GalleryFilter = { engine: string; modelCode: string; source: string };
export type Facet = { value: string; label: string; count: number };
export type GalleryFacets = { models: Facet[]; engines: Facet[]; sources: Facet[] };

export type GenerationResult = {
  imageBase64: string; // already a `data:...;base64,...` URL — drop straight into <img src>
  seed: number;
  source: "local" | "cloud";
  /** Absolute path to the auto-saved file on disk. Empty if save failed. */
  savedPath: string;
  /** Generation metadata (same as the sidecar) so the fresh image shows full details. */
  meta?: GenerationMeta | null;
};

/** Where a generation runs. */
export type GenerationMode = "local" | "cloud";

/**
 * A single generation tracked by the UI, from enqueue to completion.
 *
 * Local runs are serialized through a FIFO queue (the sidecar loads one model
 * and denoises one image at a time): a fresh local job starts as "queued" and
 * only becomes "running" when it reaches the head of the queue. Cloud runs skip
 * the queue and start "running" immediately (the cloud API handles concurrency
 * server-side). Queued/running/failed jobs live in the Activity panel; finished
 * images join the gallery.
 */
export type Job = {
  id: string;
  mode: GenerationMode;
  prompt: string;
  status: "queued" | "running" | "done" | "error";
  image?: GenerationResult;
  error?: string;
  /** Per-step progress (local only — the cloud API reports nothing mid-run). */
  progress?: GenerateProgress | null;
  /**
   * The request to dispatch, captured at enqueue time so later param tweaks
   * don't retro-change a job already waiting in the queue. Local jobs only.
   */
  request?: GenerationRequest;
  /** Epoch ms the job was enqueued — orders the queue and drives "queued" UI. */
  queuedAt: number;
  /** Epoch ms the job began running — set when it leaves the queue. */
  startedAt?: number;
  endedAt?: number;
  /** Dismissed from the Activity panel (finished images stay in the gallery). */
  hidden?: boolean;
};

export type SidecarStatus =
  | { state: "idle" }
  | { state: "starting"; port: number }
  | { state: "ready"; port: number; device: string }
  | { state: "error"; message: string }
  | { state: "stopped" };

export type LogLevel = "trace" | "info" | "warn" | "error";

// Mirrors internal/logbus/Entry. `id` is monotonic across the app's lifetime
// (used as React key + gap detection in the panel).
export type LogEntry = {
  id: number;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
};

export type PythonInfo = {
  path: string;
  version: string;
};

export type EngineInfo = {
  installed: boolean;
  venvDir: string;
  pythonPath: string;
  /** Installed imference-engine version ("" if unknown / not installed). */
  engineVersion: string;
  /** Version the desktop pins ("" under a dev source override). */
  pinnedVersion: string;
  /** installed != pinned (both known) — startup force-reinstalls in that case. */
  outdated: boolean;
};

export type InstallPhase =
  | "detect"
  | "venv"
  | "torch"
  | "sidecar-deps"
  | "engine"
  | "extras"
  | "model"
  | "done"
  | "error";

export type InstallProgress = {
  phase: InstallPhase;
  message: string;
  percentEstimate: number;
  done: boolean;
  error?: string;
};
