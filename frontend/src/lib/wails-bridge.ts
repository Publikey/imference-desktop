// Thin typed facade over the auto-generated Wails bindings. Two purposes:
// 1. give the renderer a single import surface (`api`) regardless of how
//    Wails reshapes the generated files between versions;
// 2. transparently wrap every method so entry/exit/errors land in the
//    in-app LogPanel (via api.logFromFrontend → Go logbus).
import {
  ClearLogs,
  DetectPython,
  ExportWalletPrivateKey,
  GenerateCloud,
  GenerateLocal,
  GenerateWallet,
  GetEngineInfo,
  GetLogs,
  GetSettings,
  GetSidecarStatus,
  GetWalletInfo,
  ImportWallet,
  InstallEngine,
  ListCloudModels,
  ListLocalModels,
  LogFromFrontend,
  RefreshWalletBalance,
  RestartSidecar,
  SaveSettings,
  SelectCloudModel,
  SelectLocalModel,
} from "../../wailsjs/go/main/App";
import { EventsOff, EventsOn } from "../../wailsjs/runtime/runtime";
import type {
  AppSettings,
  EngineInfo,
  GenerationRequest,
  GenerationResult,
  InstallProgress,
  LogEntry,
  LogLevel,
  ModelInfo,
  PythonInfo,
  SidecarStatus,
  WalletInfo,
} from "./types";

// Wails-generated functions are typed as (anyOfTheArgs) => Promise<any>.
// The casts here give the rest of the app the strict shapes from types.ts
// without polluting every callsite.
const raw = {
  getSettings: GetSettings as () => Promise<AppSettings>,
  // Cast through `unknown`: the generated arg type (the `Settings` class, which
  // carries a `convertValues` method) doesn't structurally overlap with the
  // plain `AppSettings` type on the contravariant parameter position.
  saveSettings: SaveSettings as unknown as (next: AppSettings) => Promise<AppSettings>,
  getSidecarStatus: GetSidecarStatus as () => Promise<SidecarStatus>,
  restartSidecar: RestartSidecar as () => Promise<void>,
  generateCloud: GenerateCloud as (req: GenerationRequest) => Promise<GenerationResult>,
  generateLocal: GenerateLocal as (req: GenerationRequest) => Promise<GenerationResult>,

  getLogs: GetLogs as () => Promise<LogEntry[]>,
  clearLogs: ClearLogs as () => Promise<void>,
  // Skipped by the wrapper — calling logFromFrontend INSIDE the wrapper
  // would loop forever ("log call A" → "log call B" → ...).
  logFromFrontend: LogFromFrontend as (
    level: LogLevel,
    source: string,
    message: string,
    data: unknown
  ) => Promise<void>,

  // Installer
  detectPython: DetectPython as () => Promise<PythonInfo>,
  getEngineInfo: GetEngineInfo as () => Promise<EngineInfo>,
  installEngine: InstallEngine as () => Promise<void>,

  // Model catalog + model selection (local downloads weights; cloud is instant)
  listLocalModels: ListLocalModels as () => Promise<ModelInfo[]>,
  listCloudModels: ListCloudModels as () => Promise<ModelInfo[]>,
  selectLocalModel: SelectLocalModel as (modelCode: string) => Promise<void>,
  selectCloudModel: SelectCloudModel as (modelCode: string) => Promise<void>,

  // Wallet (x402 mode)
  getWalletInfo: GetWalletInfo as () => Promise<WalletInfo>,
  refreshWalletBalance: RefreshWalletBalance as () => Promise<string>,
  generateWallet: GenerateWallet as () => Promise<string>,
  importWallet: ImportWallet as (privateKeyHex: string) => Promise<string>,
  exportWalletPrivateKey: ExportWalletPrivateKey as () => Promise<string>,

  onSidecarStatus: (cb: (s: SidecarStatus) => void): (() => void) => {
    EventsOn("sidecar:status", (s: SidecarStatus) => cb(s));
    return () => EventsOff("sidecar:status");
  },
  onLogEntry: (cb: (e: LogEntry) => void): (() => void) => {
    EventsOn("log:entry", (e: LogEntry) => cb(e));
    return () => EventsOff("log:entry");
  },
  onInstallProgress: (cb: (p: InstallProgress) => void): (() => void) => {
    EventsOn("install:progress", (p: InstallProgress) => cb(p));
    return () => EventsOff("install:progress");
  },
  onModelProgress: (cb: (p: InstallProgress) => void): (() => void) => {
    EventsOn("model:progress", (p: InstallProgress) => cb(p));
    return () => EventsOff("model:progress");
  },
};

const NO_WRAP = new Set([
  "logFromFrontend",
  "onSidecarStatus",
  "onLogEntry",
  "onInstallProgress",
  "onModelProgress",
]);

function wrap<K extends keyof typeof raw>(key: K, fn: (typeof raw)[K]): (typeof raw)[K] {
  if (NO_WRAP.has(key) || typeof fn !== "function") return fn;
  return (async (...args: unknown[]) => {
    const start = performance.now();
    void raw.logFromFrontend("trace", "front:api", `→ ${key}`, sanitize(key, args));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (fn as any)(...args);
      const ms = Math.round(performance.now() - start);
      void raw.logFromFrontend("trace", "front:api", `← ${key} (${ms}ms)`, {});
      return result;
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : String(err);
      void raw.logFromFrontend("error", "front:api", `× ${key} (${ms}ms): ${message}`, {});
      throw err;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// Avoid dumping API keys / base64 image payloads into the log panel.
function sanitize(method: string, args: unknown[]): unknown {
  if (method === "saveSettings" && args[0] && typeof args[0] === "object") {
    const s = args[0] as Record<string, unknown>;
    return { ...s, apiKey: s.apiKey ? "***" : "" };
  }
  return args;
}

// Build the wrapped api eagerly so every importer gets the logged version.
export const api = Object.fromEntries(
  Object.entries(raw).map(([k, v]) => [k, wrap(k as keyof typeof raw, v as never)])
) as typeof raw;

export type Api = typeof api;
