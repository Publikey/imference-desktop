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
};

/** Host-tuning knobs for the SDXL backend (IMAGE_* env contract). */
export type ImageRuntimeSettings = {
  /** "" / "auto" | cuda | cuda:N | mps | cpu */
  device?: string;
  /** SDXL TAESDxl — faster VAE decode, slight quality loss. */
  useTinyVae?: boolean;
  /** Lower peak VRAM (recommended ≤8 GB), a bit slower. */
  enableCpuOffload?: boolean;
  /** "" / "auto" / integer */
  maxGpuModels?: string;
  maxCpuModels?: string;
};

/** Host-tuning knobs for the Z-Image backend. No Tiny VAE (SDXL-only, ignored). */
export type ZImageRuntimeSettings = {
  device?: string;
  enableCpuOffload?: boolean;
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
  sdxl: ImageRuntimeSettings;
  zimage: ZImageRuntimeSettings;
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
};

export type PaymentMode = "bearer" | "x402";

export type WalletInfo = {
  configured: boolean;
  address: string;
  balanceUSDC: string;
  network: string;
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

export type GenerationResult = {
  imageBase64: string; // already a `data:...;base64,...` URL — drop straight into <img src>
  seed: number;
  source: "local" | "cloud";
  /** Absolute path to the auto-saved file on disk. Empty if save failed. */
  savedPath: string;
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
