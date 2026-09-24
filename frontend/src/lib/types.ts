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
  /** The user's LoRA library (AddLora), referenced in place. */
  loras?: LoraEntry[];
  /** Cap on the total size of downloaded weights. 0 → Go default (100 GB).
   *  Past it, least-recently-used models are evicted; the active one never is. */
  modelCacheQuotaBytes?: number;
  /** Free-space cushion to preserve on the cache volume. 0 → Go default (10 GB).
   *  A hard wall, unlike the quota: a download that would eat into it fails. */
  modelCacheMinFreeBytes?: number;
};

/** One downloaded checkpoint, as listed in Settings → Storage. */
export type CachedModel = {
  /** Filename in the managed models dir — the handle for deletion. */
  key: string;
  modelCode?: string;
  modelName?: string;
  bytes: number;
  lastUsedAt: string;
  /** Loaded in the engine: can't be deleted, never evicted. */
  active: boolean;
  /** Unknown provenance (older build, or catalog offline when indexed). Evicted first. */
  orphan: boolean;
};

/** Cheap storage readout — index totals plus one syscall. */
export type StorageInfo = {
  quotaBytes: number;
  minFreeBytes: number;
  usedBytes: number;
  freeBytes: number;
  modelsDir: string;
  baseCacheDir: string;
  engineDir: string;
};

/** Expensive storage readout — one directory walk per folder. */
export type FolderSizes = {
  modelsBytes: number;
  baseCacheBytes: number;
  engineBytes: number;
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
/**
 * Answer to "can the selected model generate right now without a hidden
 * multi-GB base-components download?". hasManifest=false means the check
 * couldn't run (self-contained model, CDN off, base not mirrored) — never
 * gate on that; the engine's lazy download still works.
 */
export type ComponentsReadiness = {
  baseRepo: string;
  hasManifest: boolean;
  ready: boolean;
  totalFiles: number;
  missingFiles: number;
  /** Sum of missing file sizes (bytes), best-effort ("at least"). */
  missingBytes: number;
};

/** Progress of a base-components download (one bar + caption). */
export type ComponentsProgress = {
  baseRepo: string;
  file: string;
  fileIndex: number;
  totalFiles: number;
  doneBytes: number;
  /** -1 when any file size was unknown → indeterminate bar. */
  totalBytes: number;
  percent: number;
  done: boolean;
};

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
  /**
   * Offload MECHANISM when offload is enabled (engine IMAGE_OFFLOAD_MODE):
   * "" or "auto" = backend+VRAM-aware pick (heavy DiTs whose compute module
   * can't fit the card get "group" — block-streamed, ~6 GB peak; the rest get
   * "model"); "model" / "group" force it. Ignored while offload is off.
   */
  offloadMode?: string;
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
  /**
   * Sampling bounds from the catalog. A missing default is the catalog saying
   * the model has no such knob — gpt-image-1 publishes neither steps nor cfg,
   * minimax-h3 no cfg — and the form then offers no control rather than a
   * slider that moves nothing. Same contract as durationDefault below.
   */
  stepsDefault?: number;
  stepsMin?: number;
  stepsMax?: number;
  cfgDefault?: number;
  cfgMin?: number;
  cfgMax?: number;
  skipDefault?: number;
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
  /** How many OPTIONAL reference images the model takes, resolved by Go from the
   *  catalog's accepts_image_input + image_input_max: 0 = none, 1 = img2img
   *  source, 2 = first + last frame. Go applies the "catalog silent → 1 for
   *  local models" fallback, so this value is final. */
  refImages?: number;
  /** Video model whose output carries an audio track (catalog has_audio). */
  hasAudio?: boolean;
  /** What the model produces: "image" | "video". Resolved by the Go side. */
  modelType?: string;
  /**
   * Clip length controls, in seconds. A missing durationDefault is the catalog
   * saying this model has NO duration knob (an image model, or a video model of
   * fixed length) — the composer then offers nothing rather than a slider that
   * changes nothing.
   */
  durationDefault?: number;
  durationMin?: number;
  durationMax?: number;
  /** Supported resolutions/ratios (im_format). Empty → generic fallback. */
  formats?: FormatOption[];
  /** Catalog organization (im_model family/group) for sorting/grouping. */
  order?: number;
  familyCode?: string;
  familyName?: string;
  /** Display rank of the family — orders the picker's cloud-family groups. */
  familyOrder?: number;
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
  /** Scales the model's per-run price for this format (1 = SD, 2 = HD). */
  creditMultiplier?: number;
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

/** One LoRA file in the user's library. */
export type LoraEntry = {
  path: string;
  name: string;
  /** Family the file was trained for ("sdxl", "sd15", "flux", …), read from its
   *  safetensors header. Absent when unrecognized. */
  family?: string;
  sizeBytes: number;
  /** Prompt words the file says it was trained with (trigger phrase or the
   *  leading tag of its training captions). */
  triggerWords?: string[];
  /** False = UNet-only LoRA: no token was learned, trigger words are optional. */
  textEncoderTrained?: boolean;
};

/** One LoRA applied to a generation. */
export type LoraRef = {
  path: string;
  name?: string;
  weight: number;
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
  /** Optional reference images by slot: 0 = img2img source (or a video's first
   *  frame), 1 = a video's last frame. Go mirrors slot 0 onto sourceImage. */
  refImages?: string[];
  /** img2img: base64 (data-URL ok) source image to denoise from. Empty/undefined = text2img.
   *  Kept as the wire field for slot 0 — the engine contract speaks source_image. */
  sourceImage?: string;
  /** Denoising strength 0–1 (0 keeps the reference, 1 ignores it). Only with a reference image. */
  strength?: number;
  /** Clip length in seconds — cloud video models that publish duration bounds.
   *  The local sidecar takes no such kwarg, so it is never sent there. */
  durationS?: number;
  /** The format the user picked. Cloud pricing depends on it (credit_multiplier). */
  formatCode?: string;
  /** LoRAs stacked on the local model (local mode, LoRA-capable backends only). */
  loras?: LoraRef[];
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
  /** Media kind by extension: "image" | "video" — drives <img> vs <video>. */
  kind?: string;
  source: string;
  seed: number;
  savedPath: string;
  /** Pixel dimensions (0 when unknown) — used to reserve the masonry tile's box. */
  width: number;
  height: number;
  /** Generation metadata from the sidecar JSON. Absent for pre-feature images. */
  meta?: GenerationMeta | null;
  /**
   * Runtime-only in-memory bytes (data-URL) for an image merged from a just-
   * finished generation — lets its tile render instantly without a disk read.
   * Never sent by the backend; absent for images loaded from the folder.
   */
  src?: string;
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
  loras?: LoraRef[];
  createdAt: string;
};

/** A cloud generation persisted as in-flight (survives app close). Returned by
 *  api.listPendingCloudJobs() to rehydrate the Activity list on launch. */
export type PendingCloudJob = {
  jobId: string;
  requestId: string;
  kind: string; // "image" | "video"
  rail: string; // "credits" | "x402"
  prompt: string;
  meta?: GenerationMeta | null;
  createdAt: string;
};

/** Payload of the "cloud:resolved" event — a resumed cloud job finished. */
export type CloudResolved = {
  jobId: string;
  result?: GenerationResult | null;
  error?: string;
};

export type GalleryFilter = { engine: string; modelCode: string; source: string; text: string };
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
  /**
   * The local model this job was enqueued for. A job can be queued for a model
   * that's cached but not loaded yet (the primary button activates it in the
   * background), so the dispatcher must not hand it to whatever the engine
   * happens to have resident. Local jobs only.
   */
  modelCode?: string;
  /** Epoch ms the job was enqueued — orders the queue and drives "queued" UI. */
  queuedAt: number;
  /** Epoch ms the job began running — set when it leaves the queue. */
  startedAt?: number;
  endedAt?: number;
  /** Dismissed from the Activity panel (finished images stay in the gallery). */
  hidden?: boolean;
  /**
   * Rehydrated on launch from a persisted pending cloud record (its id is the
   * Go-side job id). Only these can be given up on: a live cloud run owns no
   * record yet and settles on its own within the poll budget.
   */
  resumed?: boolean;
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
  /** installed != pinned (both known) — startup force-reinstalls in that case.
   *  Always false for an editable dev install (never auto-clobbered). */
  outdated: boolean;
  /** True when the engine is an editable (`pip install -e`) checkout — a local
   *  dev source, not an official release. */
  dev: boolean;
  /** The editable checkout's source directory when `dev` is true ("" otherwise). */
  devPath: string;
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
  | "error"
  | "cancelled";

export type InstallProgress = {
  phase: InstallPhase;
  /** English, always set. The log line, and the fallback when messageKey is absent. */
  message: string;
  /** i18n key for the user-facing text. Go can't translate (the language lives
   *  in the renderer), so it sends a key plus pre-formatted values instead. */
  messageKey?: string;
  messageArgs?: Record<string, string>;
  percentEstimate: number;
  done: boolean;
  error?: string;
};
