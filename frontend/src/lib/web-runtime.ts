// Web build replacement for "@wailsio/runtime" (aliased in vite.config.ts when
// mode === "web"). The generated bindings and wails-bridge.ts keep calling
// Call.ByID / Call.ByName / Events.On exactly as in the desktop; here those go
// to the Go web server instead of the Wails webview:
//   calls  -> POST web/call  {methodID | methodName, args}  -> {result} | {error}
//   events <- GET  web/events (Server-Sent Events: {name, data})
// URLs are relative to the app page, so the same build runs at "/" or "/app/".
// Create and CancellablePromise are the real runtime's pure-JS helpers.
import * as Create from "wails-runtime-dist/create.js";
import { CancellablePromise } from "wails-runtime-dist/cancellable.js";

export { Create, CancellablePromise };

const CSRF = { "X-Imference-Web": "1" };

function post(url: string, body: unknown, signal: AbortSignal): Promise<{ r: Response; j: any }> {
  return fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...CSRF },
    body: JSON.stringify(body),
    signal,
  }).then(async (r) => ({ r, j: await r.json().catch(() => ({})) }));
}

// A gateway blip while waiting on a long call (proxy restart, ingress
// timeout) is retried: the run goes on server-side.
const WAIT_RETRY = new Set([502, 503, 504]);

function rpc(body: { methodID?: number; methodName?: string; args: unknown[] }): CancellablePromise<any> {
  const ctl = new AbortController();
  const p = new CancellablePromise<any>((resolve, reject) => {
    (async () => {
      let { r, j } = await post("web/call", body, ctl.signal);
      // Long calls (generations, tools) answer 202 {pending} at once; their
      // response is then collected from web/call/wait (web_async.go), so no
      // request outlives the hosting's timeout.
      let blips = 0;
      while (r.status === 202 && j.pending) {
        let next: { r: Response; j: any };
        try {
          next = await post("web/call/wait", { id: j.pending }, ctl.signal);
        } catch (e) {
          if (ctl.signal.aborted || ++blips > 5) throw e;
          await new Promise((res) => setTimeout(res, 2000));
          continue;
        }
        if (WAIT_RETRY.has(next.r.status) && ++blips <= 5) {
          await new Promise((res) => setTimeout(res, 2000));
          continue;
        }
        ({ r, j } = next);
        blips = 0;
      }
      if (!r.ok) {
        // j.code tags the payment failures (web_pay.go): see web-pay.ts.
        throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { code: j.code || "" });
      }
      return j.result;
    })().then(resolve, reject);
  }, () => ctl.abort());
  return p;
}

// ------------------------------------------------------- client gallery
// When the server runs with a client gallery (the default), the gallery calls
// never leave the browser (web-gallery.ts reads/writes the user's folder), and
// results that come back from the server are saved there.

/** Wails binding ID: FNV-32a of "main.App.<Method>" (same as the Go side). */
export function bindingID(fqn: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fqn.length; i++) {
    h ^= fqn.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const GALLERY_METHODS = [
  "ListSavedImages", "GalleryFacets", "GetSavedImage", "DeleteSavedImage", "RevealInFolder",
  "GenerateCloud", "RunTool",
];
const nameByID = new Map(GALLERY_METHODS.map((n) => [bindingID("main.App." + n), n]));

let galleryMode: Promise<"client" | "server"> | null = null;
function clientGallery(): Promise<boolean> {
  galleryMode ??= rpc({ methodName: "web.GetConfig", args: [] })
    .then((c: any) => (c?.gallery === "server" ? "server" : "client"))
    .catch(() => "client" as const);
  return galleryMode.then((m) => m === "client");
}

const savedByJob = new Map<string, string>();
let outboxDrain: Promise<void> | null = null;

/** Save the cloud results that finished while no tab was open (server outbox). */
function drainOutbox(): Promise<void> {
  const run = async () => {
    const g = await import("./web-gallery");
    const items: any[] = (await rpc({ methodName: "main.App.TakeClientGalleryOutbox", args: [] })) || [];
    for (const it of items) {
      const r = it.result || {};
      if (!r.imageBase64) continue;
      try {
        savedByJob.set(it.jobId, await g.saveDataURL(r.imageBase64, r.source || "cloud", r.seed || 0, r.meta));
      } catch (e) {
        console.error("gallery: could not save a resumed result", e);
      }
    }
  };
  outboxDrain = (outboxDrain ?? Promise.resolve()).then(run, run);
  return outboxDrain;
}

let startupDrain: Promise<void> | null = null;

async function localCall(name: string, args: any[]): Promise<{ handled: boolean; value?: any }> {
  if (!nameByID.size || !(await clientGallery())) return { handled: false };
  const g = await import("./web-gallery");
  switch (name) {
    case "ListSavedImages":
      startupDrain ??= drainOutbox();
      await startupDrain;
      return { handled: true, value: await g.listSavedImages(args[0], args[1], args[2]) };
    case "GalleryFacets":
      return { handled: true, value: await g.galleryFacets() };
    case "GetSavedImage":
      return { handled: true, value: await g.getSavedImage(args[0]) };
    case "DeleteSavedImage":
      await g.deleteSavedImage(args[0]);
      return { handled: true, value: null };
    case "RevealInFolder":
      return { handled: true, value: null };
    case "GenerateCloud": {
      const res: any = await rpc({ methodName: "main.App.GenerateCloud", args });
      if (res?.imageBase64) res.savedPath = await g.saveDataURL(res.imageBase64, res.source || "cloud", res.seed || 0, res.meta);
      return { handled: true, value: res };
    }
    case "RunTool": {
      const req = { ...(args[0] || {}) };
      const inputs: Record<string, string[]> = {};
      let sourceName = "";
      // Gallery names become data URIs: the server cannot read the user's disk.
      for (const [k, vals] of Object.entries<string[]>(req.inputs || {})) {
        inputs[k] = await Promise.all(
          (vals || []).map(async (v) => {
            if (!v || v.startsWith("data:")) return v;
            if (k === "image" && !sourceName) sourceName = v;
            return g.getSavedImage(v);
          }),
        );
      }
      req.inputs = inputs;
      if (sourceName && !req.sourceMeta) req.sourceMeta = (await g.savedMeta(sourceName).catch(() => undefined)) ?? null;
      const res: any = await rpc({ methodName: "main.App.RunTool", args: [req] });
      if (!req.noSave) {
        for (const o of res?.outputs || []) {
          if (!o.dataUrl || !o.meta) continue;
          if (sourceName) o.meta.sourceImage = sourceName;
          o.savedName = await g.saveDataURL(o.dataUrl, "tool", o.seed || 0, o.meta);
          o.path = o.savedName;
          delete o.dataUrl;
        }
      }
      return { handled: true, value: res };
    }
  }
  return { handled: false };
}

/**
 * Set by web-pay.ts at startup: runs a paid call (GenerateCloud, RunTool) and
 * opens the payment dialog when the server says it can't be paid. A hook, so
 * this module never imports the app's code (which imports this one).
 */
export const payHooks: {
  withPayment?: <T>(method: string, args: any[], run: () => Promise<T>) => Promise<T>;
} = {};
const PAID_METHODS = ["GenerateCloud", "RunTool"];

function call(body: { methodID?: number; methodName?: string; args: unknown[] }): CancellablePromise<any> {
  const name = body.methodName?.startsWith("main.App.")
    ? body.methodName.slice("main.App.".length)
    : body.methodID !== undefined
      ? nameByID.get(body.methodID)
      : undefined;
  if (!name || !GALLERY_METHODS.includes(name)) return rpc(body);
  const run = () =>
    localCall(name, body.args as any[]).then((r) => (r.handled ? r.value : rpc(body)));
  const pay = payHooks.withPayment;
  return new CancellablePromise<any>((resolve, reject) => {
    (pay && PAID_METHODS.includes(name) ? pay(name, body.args as any[], run) : run()).then(resolve, reject);
  });
}

export const Call = {
  ByID: (methodID: number, ...args: unknown[]) => call({ methodID, args }),
  ByName: (methodName: string, ...args: unknown[]) => call({ methodName, args }),
};

// ------------------------------------------------------------------ events

export class WailsEvent {
  constructor(public name: string, public data: any = null, public sender: string = "") {}
}

type Cb = (e: WailsEvent) => void;
const listeners = new Map<string, Set<Cb>>();
let source: EventSource | null = null;

function connect() {
  if (source) return;
  source = new EventSource("web/events", { withCredentials: true });
  source.onmessage = (m) => {
    let ev: { name: string; data: any };
    try {
      ev = JSON.parse(m.data);
    } catch {
      return;
    }
    if (ev.name === "cloud:resolved" && ev.data?.result) {
      // A resumed job: its result is waiting in the server outbox; save it to
      // the user's gallery first, then tell the app where it landed.
      void clientGallery().then(async (client) => {
        if (client) {
          await drainOutbox();
          ev.data.result.savedPath = savedByJob.get(ev.data.jobId) || "";
        }
        listeners.get(ev.name)?.forEach((cb) => cb(new WailsEvent(ev.name, ev.data)));
      });
      return;
    }
    listeners.get(ev.name)?.forEach((cb) => cb(new WailsEvent(ev.name, ev.data)));
  };
  // EventSource reconnects by itself; nothing else to do on error.
}

function On(name: string, cb: Cb): () => void {
  connect();
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

function Once(name: string, cb: Cb): () => void {
  const off = On(name, (e) => {
    off();
    cb(e);
  });
  return off;
}

export const Events = {
  On,
  Once,
  OnMultiple: (name: string, cb: Cb, _max: number) => On(name, cb),
  Off: (...names: string[]) => names.forEach((n) => listeners.delete(n)),
  OffAll: () => listeners.clear(),
  Emit: async (_name: string, _data?: unknown) => {
    /* frontend -> backend events are not used by the app */
  },
};

export const Browser = {
  OpenURL: (url: string | URL) => {
    window.open(String(url), "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
};
