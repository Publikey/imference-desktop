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
  | "done"
  | "error";

export type InstallProgress = {
  phase: InstallPhase;
  message: string;
  percentEstimate: number;
  done: boolean;
  error?: string;
};
