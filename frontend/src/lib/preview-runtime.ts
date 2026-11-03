// Design preview replacement for "@wailsio/runtime" (vite --mode preview or
// preview-web, see vite.config.ts). Every Go binding answers from fixtures so
// the real UI renders in a plain browser, in realistic states, with no engine,
// no GPU and no network but the catalog mock (design/bench/mock-api.mjs).
//
// Scenario: ?scenario=ready (default) | empty | firstrun
// Catalog:  ?api=http://127.0.0.1:8799 (default)
// Gallery:  ?gallery=code1,code2,… (model codes, in order) curates the images
//           shown, for product shots; default = every catalog image.
//
// Never part of a shipped build: only the preview modes alias it in.
import * as Create from "wails-runtime-dist/create.js";
import { CancellablePromise } from "wails-runtime-dist/cancellable.js";

export { Create, CancellablePromise };

const q = new URLSearchParams(location.search);
const scenario = q.get("scenario") || "ready";
const API = q.get("api") || "http://127.0.0.1:8799";

// Method IDs are FNV-32a of "main.App.<Method>" (same as the Go side).
function bindingID(fqn: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fqn.length; i++) {
    h ^= fqn.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const METHODS =
  "AddLora CancelModelDownload CancelTool CancelToolWeights CheckForUpdate CheckModelReadiness ClearLogs DeleteCachedModel DeleteSavedImage DetectPython DownloadCatalogLora DownloadModelComponents DownloadToolWeights DropPendingCloudJob EngineStatus EnsureLocalModel ExportWalletPrivateKey GalleryFacets GenerateCloud GenerateLocal GenerateWallet GetCreditBalance GetEngineInfo GetFolderSizes GetLocalAPIInfo GetLogs GetSavedImage GetSettings GetSidecarStatus GetStorageInfo GetToolsSettings GetVersion GetWalletInfo ImportWallet InstallEngine ListCachedModels ListCatalogLoras ListCloudLoras ListCloudModels ListEditModels ListLocalModels ListPendingCloudJobs ListSavedImages ListTools LogFromFrontend OpenCacheFolder PickLoraFile PickModelFile ProbeTools PurgeBaseComponentsCache RecheckPendingCloud RefreshWalletBalance ReleaseTools RemoveCustomModel RemoveLora RestartSidecar RevealInFolder RunTool SaveSettings SelectCloudModel SelectLocalModel SetToolsSettings StartSidecar StopLocalGeneration StopSidecar SwitchBackFromEditModel SwitchToEditModel TakeClientGalleryOutbox ToolGenModels UseCustomModel".split(
    " ",
  );
const nameByID = new Map(METHODS.map((n) => [bindingID("main.App." + n), n]));

// ------------------------------------------------------------ fixtures

const json = (u: string) => fetch(API + u).then((r) => r.json()).catch(() => ({}));
let catalog: Promise<{ models: any[]; loras: any[]; formats: any[] }> | null = null;
function loadCatalog() {
  catalog ??= Promise.all([json("/api/models?type=all"), json("/api/loras"), json("/api/formats")]).then(
    ([m, l, f]) => ({ models: m.models || [], loras: l.loras || [], formats: f.formats || [] }),
  );
  return catalog;
}

function toModel(m: any, formats: any[]) {
  return {
    modelCode: m.model_code,
    name: m.name,
    shortDescription: m.short_description || "",
    mediumDescription: m.medium_description || "",
    image: m.image || "",
    modelUrl: m.im_local ? `https://models.example/${m.model_code}.safetensors` : "",
    promptPre: "",
    promptNegative: "",
    stepsDefault: m.steps_default ?? undefined,
    stepsMin: m.steps_min ?? undefined,
    stepsMax: m.steps_max ?? undefined,
    cfgDefault: m.cfg_default ?? undefined,
    cfgMin: m.cfg_min ?? undefined,
    cfgMax: m.cfg_max ?? undefined,
    schedulerDefault: "",
    formatCode: m.format_code || "sq",
    backendType: m.im_engine,
    cost: m.im_cost,
    canLocal: !!m.im_local,
    canCloud: !!m.im_cloud,
    refImages: m.model_type === "video" ? 1 : 1,
    modelType: m.model_type || "image",
    durationDefault: m.model_type === "video" ? 5 : undefined,
    durationMin: m.model_type === "video" ? 2 : undefined,
    durationMax: m.model_type === "video" ? 8 : undefined,
    formats: formats
      .filter((f) => f.model_code === m.model_code)
      .map((f) => ({ formatCode: f.format_code, name: f.name, width: f.width, height: f.height, ratio: f.ratio, isDefault: f.is_default })),
    order: m.model_order,
    familyCode: m.model_family_code,
    familyName: m.family_name,
    familyOrder: m.family_order,
    external: m.im_engine === "external",
  };
}

const PROMPTS = [
  "A rainy train window at dusk, film grain, soft bokeh city lights",
  "Portrait of an elven ranger in a misty forest, golden hour, detailed",
  "A tiger stepping out of dense jungle foliage, sharp focus, 85mm",
  "Cozy reading nook with warm lamp light, watercolor illustration",
  "Retro sci-fi city skyline, 90s anime cel shading, neon haze",
  "Close-up of a woman by a window, natural light, editorial photo",
];

let settings: any = null;
async function getSettings() {
  if (settings) return settings;
  const { models, formats } = await loadCatalog();
  const local = models.find((m) => m.im_local) || models[0];
  const cloud = models.find((m) => m.model_code === "krea-2-turbo") || models[0];
  settings = {
    apiKey: scenario === "firstrun" ? "" : "im_live_demo",
    pythonPath: "",
    sdxlPath: "/Users/demo/Imference/models",
    cloudModel: cloud?.model_code || "",
    outputDir: "/Users/demo/Pictures/Imference",
    paymentMode: "bearer",
    walletAddress: "",
    localModel: scenario === "firstrun" || !local ? null : toModel(local, formats),
    cloudModelInfo: cloud ? toModel(cloud, formats) : null,
    customModels: [],
    loras: [],
    tools: { mode: "auto" },
  };
  return settings;
}

async function savedImages(offset: number, limit: number) {
  if (scenario === "empty" || scenario === "firstrun") return [];
  const { models } = await loadCatalog();
  const pick = q.get("gallery")?.split(",").filter(Boolean);
  const pool = pick
    ? pick.map((c) => models.find((m) => m.model_code === c)).filter(Boolean)
    : models.filter((m) => m.model_type !== "video");
  const list = pool.map((m: any, i: number) => ({
    name: `${String(1000 + i)}-${m.model_code}.webp`,
    kind: "image",
    source: i % 3 === 0 ? "cloud" : "local",
    seed: 4242 + i * 17,
    savedPath: `/Users/demo/Pictures/Imference/${m.model_code}.webp`,
    width: 768,
    height: 1024,
    src: m.image,
    meta: {
      prompt: PROMPTS[i % PROMPTS.length],
      source: i % 3 === 0 ? "cloud" : "local",
      modelCode: m.model_code,
      modelName: m.name,
      engine: m.im_engine,
      width: 768,
      height: 1024,
      numSteps: 28,
      guidanceScale: 5,
      seed: 4242 + i * 17,
      createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
    },
  }));
  return list.slice(offset, offset + limit);
}

const TOOL_IDS: [string, string, string][] = [
  ["remove-background", "Remove background", "image"],
  ["upscale", "Upscale 4x", "image"],
  ["magic-eraser", "Magic eraser", "image"],
  ["restore-faces", "Restore faces", "image"],
  ["describe", "Describe", "image"],
  ["instruct-edit", "Edit with words", "generation"],
  ["vary", "Vary", "generation"],
  ["video-trim", "Trim video", "video"],
];
function tools() {
  return TOOL_IDS.map(([id, name, category], i) => ({
    id, version: "1", name, description: name, category, mcpName: id,
    inputs: [{ name: "image", type: "image", required: true, multiple: false }],
    params: [], outputs: [{ name: "image", type: "image" }],
    runtimes: { local: ["cpu", "cuda"] }, credits: 2, cloudAvailable: true, weightsMb: 120,
    weights: [{ sizeMb: 120, cached: true }],
    badge: i % 4 === 3 ? "cloud" : "local", device: "cuda", priceCredits: 2, priceUsd: 0.002,
  }));
}

async function handle(name: string, args: any[]): Promise<any> {
  switch (name) {
    case "GetSettings":
    case "SaveSettings":
      if (name === "SaveSettings" && args[0]) settings = args[0];
      return getSettings();
    case "SelectCloudModel":
    case "SelectLocalModel": {
      const { models, formats } = await loadCatalog();
      const m = models.find((x) => x.model_code === args[0]);
      const s = await getSettings();
      if (m && name === "SelectCloudModel") Object.assign(s, { cloudModel: m.model_code, cloudModelInfo: toModel(m, formats) });
      if (m && name === "SelectLocalModel") s.localModel = toModel(m, formats);
      return s;
    }
    case "GetVersion":
      return "0.9.0";
    case "CheckForUpdate":
      return { available: false, current: "0.9.0", latest: "0.9.0" };
    case "GetEngineInfo":
      return { installed: scenario !== "firstrun", venvDir: "", pythonPath: "", engineVersion: "1.4.2", pinnedVersion: "1.4.2", outdated: false, dev: false, devPath: "" };
    case "GetSidecarStatus":
      return scenario === "firstrun" ? { state: "stopped" } : { state: "ready", port: 7861, device: "cuda" };
    case "EngineStatus":
      return { gpuName: "NVIDIA GeForce RTX 4080", gpuVendor: "nvidia", vramGiB: 16, toolsUp: true, toolsBusy: false, toolsWarm: [] };
    case "DetectPython":
      return { path: "/usr/bin/python3", version: "3.12.4" };
    case "ListLocalModels": {
      const { models, formats } = await loadCatalog();
      return models.filter((m) => m.im_local).map((m) => toModel(m, formats));
    }
    case "ListCloudModels": {
      const { models, formats } = await loadCatalog();
      return models.filter((m) => m.im_cloud).map((m) => toModel(m, formats));
    }
    case "ListCatalogLoras":
    case "ListCloudLoras": {
      const { loras } = await loadCatalog();
      return loras.map((l) => ({
        loraCode: l.lora_code, name: l.name, shortDescription: l.short_description, image: l.image,
        category: l.category, isNew: l.is_new, engine: l.im_engine, familyCode: l.model_family_code,
        compatibleFamilyCodes: l.compatible_family_codes, triggerWords: l.trigger_words,
        weightDefault: l.weight_default, weightMin: l.weight_min, weightMax: l.weight_max, downloaded: false,
      }));
    }
    case "ListSavedImages":
      return savedImages(args[0] || 0, args[1] || 60);
    case "GetSavedImage": {
      const all = await savedImages(0, 1000);
      return all.find((i) => i.name === args[0])?.src || "";
    }
    case "GalleryFacets": {
      const all = await savedImages(0, 1000);
      const count = (k: (i: any) => string, l: (i: any) => string) => {
        const m = new Map<string, { value: string; label: string; count: number }>();
        for (const i of all) {
          const v = k(i);
          const e = m.get(v) || { value: v, label: l(i), count: 0 };
          e.count++;
          m.set(v, e);
        }
        return [...m.values()];
      };
      return { models: count((i) => i.meta.modelCode, (i) => i.meta.modelName), engines: count((i) => i.meta.engine, (i) => i.meta.engine), sources: count((i) => i.source, (i) => i.source) };
    }
    case "GetCreditBalance":
      return { configured: scenario !== "firstrun", credits: 4496 };
    case "GetWalletInfo":
      return { configured: false, address: "", balanceUSDC: "0", network: "base" };
    case "ListPendingCloudJobs":
    case "ListCachedModels":
    case "GetLogs":
    case "TakeClientGalleryOutbox":
      return [];
    case "ListTools":
    case "ProbeTools":
      return tools();
    case "GetToolsSettings":
      return { mode: "auto" };
    case "GetStorageInfo":
      return { quotaBytes: 100e9, minFreeBytes: 10e9, usedBytes: 38.4e9, freeBytes: 412e9, modelsDir: "/Users/demo/Imference/models", wan: {} };
    case "GetFolderSizes":
      return { models: 38.4e9, outputs: 1.2e9, engine: 6.1e9, cache: 2.4e9 };
    case "GetLocalAPIInfo":
      return { enabled: true, url: "http://127.0.0.1:7862", token: "demo" };
    case "ListEditModels": {
      // A local instruction-edit model already loaded (the desktop pitch).
      const edit = {
        modelCode: "qwen-image-edit-2511", name: "Qwen-Image-Edit 2511", shortDescription: "Edit with plain words",
        mediumDescription: "", image: "", modelUrl: "https://models.example/qwen-image-edit-2511.safetensors",
        promptPre: "", promptNegative: "", schedulerDefault: "", formatCode: "sq", backendType: "qwenimage-edit",
        cost: 2, canLocal: true, canCloud: true, modelType: "image",
      };
      return { local: edit, cloud: [edit], defaultCloud: edit.modelCode, localCandidate: edit, localCandidateCached: true };
    }
    case "CheckModelReadiness":
      return { ready: true, missing: [], bytes: 0 };
    case "GenerateLocal":
    case "GenerateCloud": {
      // A believable run: progress events, then a catalog image as the result.
      const req = args[0] || {};
      const { models } = await loadCatalog();
      const m = models.find((x) => x.model_code === (req.modelCode || req.cloudModel)) || models[(Math.random() * models.length) | 0];
      for (let s = 1; s <= 12; s++) {
        await new Promise((r) => setTimeout(r, 180));
        emit("generate:progress", { jobId: req.jobId, step: s, total: 12, percent: Math.round((s / 12) * 100) });
      }
      return { imageBase64: m.image, seed: 1234, source: name === "GenerateLocal" ? "local" : "cloud", savedPath: "", meta: { prompt: req.prompt || "", source: "local", modelCode: m.model_code, modelName: m.name, seed: 1234, createdAt: new Date().toISOString() } };
    }
    default:
      return null;
  }
}

// --------------------------------------------------------------- calls

function call(name: string | undefined, args: unknown[]): CancellablePromise<any> {
  return new CancellablePromise<any>((resolve, reject) => {
    if (!name) return resolve(null);
    handle(name, args as any[]).then(resolve, reject);
  });
}

export const Call = {
  ByID: (methodID: number, ...args: unknown[]) => call(nameByID.get(methodID), args),
  ByName: (methodName: string, ...args: unknown[]) => call(methodName.replace(/^main\.App\./, ""), args),
};

// -------------------------------------------------------------- events

export class WailsEvent {
  constructor(public name: string, public data: any = null, public sender: string = "") {}
}
type Cb = (e: WailsEvent) => void;
const listeners = new Map<string, Set<Cb>>();
function emit(name: string, data: unknown) {
  listeners.get(name)?.forEach((cb) => cb(new WailsEvent(name, data)));
}
function On(name: string, cb: Cb): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(cb);
  return () => void set!.delete(cb);
}

export const Events = {
  On,
  Once: (name: string, cb: Cb) => {
    const off = On(name, (e) => {
      off();
      cb(e);
    });
    return off;
  },
  OnMultiple: (name: string, cb: Cb) => On(name, cb),
  Off: (...names: string[]) => names.forEach((n) => listeners.delete(n)),
  OffAll: () => listeners.clear(),
  Emit: async (name: string, data?: unknown) => emit(name, data),
};

export const Browser = {
  OpenURL: (url: string | URL) => {
    window.open(String(url), "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
};

// Web-target hooks that main.tsx / web-pay.ts reach for.
export const payHooks: { withPayment?: unknown } = {};
export { bindingID };
