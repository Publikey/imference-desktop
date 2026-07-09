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
  GetCreditBalance,
  GetEngineInfo,
  GetLogs,
  GetSettings,
  GetSidecarStatus,
  GetWalletInfo,
  ImportWallet,
  DeleteSavedImage,
  GalleryFacets,
  GetSavedImage,
  InstallEngine,
  ListCloudModels,
  ListLocalModels,
  ListSavedImages,
  LogFromFrontend,
  RefreshWalletBalance,
  RestartSidecar,
  SaveSettings,
  SelectCloudModel,
  SelectLocalModel,
  StartSidecar,
  StopSidecar,
} from "../../bindings/imference-desktop-go/app";
import { Events } from "@wailsio/runtime";
import type {
  AppSettings,
  CreditInfo,
  EngineInfo,
  GenerateProgress,
  GenerationRequest,
  GenerationResult,
  InstallProgress,
  LogEntry,
  LogLevel,
  GalleryFacets as GalleryFacetsType,
  GalleryFilter,
  ModelInfo,
  PythonInfo,
  SavedImage,
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
  // Local engine lifecycle — the engine no longer auto-starts; the home-screen
  // control drives it.
  startSidecar: StartSidecar as () => Promise<void>,
  stopSidecar: StopSidecar as () => Promise<void>,
  generateCloud: GenerateCloud as (req: GenerationRequest) => Promise<GenerationResult>,
  generateLocal: GenerateLocal as (req: GenerationRequest) => Promise<GenerationResult>,
  // Pass the (possibly unsaved draft) API key; Go falls back to the saved one
  // when "" is given. The key arg is redacted from logs in sanitize() below.
  getCreditBalance: GetCreditBalance as (apiKey: string) => Promise<CreditInfo>,

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
  // Cloud model: pick from the full catalog; persists code + full entry.
  selectCloudModel: SelectCloudModel as (modelCode: string) => Promise<void>,
  // Saved-image gallery (output folder history). listSavedImages returns one
  // page of metadata (optionally filtered); getSavedImage fetches one file's
  // bytes (base64) lazily; deleteSavedImage removes a file; galleryFacets lists
  // the distinct filterable values.
  listSavedImages: ListSavedImages as (
    offset: number,
    limit: number,
    filter: GalleryFilter
  ) => Promise<SavedImage[]>,
  getSavedImage: GetSavedImage as (name: string) => Promise<string>,
  deleteSavedImage: DeleteSavedImage as (name: string) => Promise<void>,
  galleryFacets: GalleryFacets as () => Promise<GalleryFacetsType>,

  // Wallet (x402 mode)
  getWalletInfo: GetWalletInfo as () => Promise<WalletInfo>,
  refreshWalletBalance: RefreshWalletBalance as () => Promise<string>,
  generateWallet: GenerateWallet as () => Promise<string>,
  importWallet: ImportWallet as (privateKeyHex: string) => Promise<string>,
  exportWalletPrivateKey: ExportWalletPrivateKey as () => Promise<string>,

  // Wails v3: Events.On(name, cb) returns the unsubscribe fn directly, and the
  // callback receives a WailsEvent whose `.data` is the Go-emitted payload
  // (Go's Event.Emit(name, x) → e.data === x).
  onSidecarStatus: (cb: (s: SidecarStatus) => void): (() => void) =>
    Events.On("sidecar:status", (e) => cb(e.data as SidecarStatus)),
  onLogEntry: (cb: (e: LogEntry) => void): (() => void) =>
    Events.On("log:entry", (e) => cb(e.data as LogEntry)),
  onInstallProgress: (cb: (p: InstallProgress) => void): (() => void) =>
    Events.On("install:progress", (e) => cb(e.data as InstallProgress)),
  onModelProgress: (cb: (p: InstallProgress) => void): (() => void) =>
    Events.On("model:progress", (e) => cb(e.data as InstallProgress)),
  onGenerateProgress: (cb: (p: GenerateProgress) => void): (() => void) =>
    Events.On("generate:progress", (e) => cb(e.data as GenerateProgress)),
};

const NO_WRAP = new Set([
  "logFromFrontend",
  "onSidecarStatus",
  "onLogEntry",
  "onInstallProgress",
  "onModelProgress",
  "onGenerateProgress",
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
  // getCreditBalance(apiKey): never log the key itself.
  if (method === "getCreditBalance") {
    return [args[0] ? "***" : ""];
  }
  return args;
}

// Build the wrapped api eagerly so every importer gets the logged version.
export const api = Object.fromEntries(
  Object.entries(raw).map(([k, v]) => [k, wrap(k as keyof typeof raw, v as never)])
) as typeof raw;

export type Api = typeof api;
