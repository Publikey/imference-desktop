// Web build replacement for "@wailsio/runtime" (aliased in vite.config.ts when
// mode === "web"). The generated bindings and wails-bridge.ts keep calling
// Call.ByID / Call.ByName / Events.On exactly as in the desktop; here those go
// to the Go web server instead of the Wails webview:
//   calls  -> POST /web/call  {methodID | methodName, args}  -> {result} | {error}
//   events <- GET  /web/events (Server-Sent Events: {name, data})
// Create and CancellablePromise are the real runtime's pure-JS helpers.
import * as Create from "wails-runtime-dist/create.js";
import { CancellablePromise } from "wails-runtime-dist/cancellable.js";

export { Create, CancellablePromise };

const CSRF = { "X-Imference-Web": "1" };

function rpc(body: { methodID?: number; methodName?: string; args: unknown[] }): CancellablePromise<any> {
  const ctl = new AbortController();
  const p = new CancellablePromise<any>((resolve, reject) => {
    fetch("/web/call", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...CSRF },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
      .then(async (r) => {
        if (r.status === 401) {
          window.location.href = "/login";
          return reject(new Error("not signed in"));
        }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return reject(new Error(j.error || `HTTP ${r.status}`));
        resolve(j.result);
      })
      .catch(reject);
  }, () => ctl.abort());
  return p;
}

export const Call = {
  ByID: (methodID: number, ...args: unknown[]) => rpc({ methodID, args }),
  ByName: (methodName: string, ...args: unknown[]) => rpc({ methodName, args }),
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
  source = new EventSource("/web/events", { withCredentials: true });
  source.onmessage = (m) => {
    let ev: { name: string; data: any };
    try {
      ev = JSON.parse(m.data);
    } catch {
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
