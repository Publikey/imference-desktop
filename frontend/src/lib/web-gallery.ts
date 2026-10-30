// Web build: the gallery lives on the user's own disk, not on the server.
//
// Two backends behind one FileSystemDirectoryHandle:
//   - "folder":  a real folder the user picks (File System Access API —
//                Chrome / Edge / Brave / Opera desktop); the handle is kept in
//                IndexedDB, permission is re-asked when the browser drops it;
//   - "browser": the origin-private file system (OPFS) — every modern browser,
//                invisible to the user, cleared with the site's data.
// Files use the desktop format: "<YYYYMMDD-HHMMSS>_<source>_<seed>.<ext>" plus
// a "<file>.json" metadata sidecar, so the desktop app and the web app can
// share one folder.
//
// The methods mirror the Go App's gallery bindings (ListSavedImages,
// GalleryFacets, GetSavedImage, DeleteSavedImage); web-runtime.ts routes those
// calls here instead of to the server.

import { GALLERY_CHANGED_EVENT } from "./target";

type Meta = Record<string, any> & {
  prompt?: string;
  source?: string;
  modelCode?: string;
  modelName?: string;
  engine?: string;
  width?: number;
  height?: number;
  seed?: number;
};

export type GalleryMode = "folder" | "browser";
export type GalleryStatus = {
  mode: GalleryMode;
  folderName: string;
  needsPermission: boolean; // folder chosen but the browser wants a click to re-grant access
  folderSupported: boolean; // File System Access API available
};

const EXT_KIND: Record<string, string> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
  ".mp4": "video", ".webm": "video",
};
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm",
};
const EXT_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm",
};

const MODE_KEY = "imweb.gallery.mode";
const DB = "imference-web";
const STORE = "handles";

// ------------------------------------------------------------- pure helpers

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

/** "<ts>_<source>_<seed>.<ext>" -> {source, seed}; same rules as Go parseSavedName. */
export function parseSavedName(name: string): { source: string; seed: number } {
  const base = name.slice(0, name.length - extOf(name).length);
  const parts = base.split("_");
  if (parts.length < 3) return { source: "", seed: 0 };
  const last = parts[parts.length - 1];
  return { source: parts.slice(1, -1).join("_"), seed: /^[+-]?\d+$/.test(last) ? parseInt(last, 10) : 0 };
}

/** Same as Go imagesink.sanitize. */
export function sanitizeSource(s: string): string {
  const out = s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return out || "unknown";
}

export function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function matchFilter(m: Meta | undefined, f: { engine?: string; modelCode?: string; source?: string; text?: string }): boolean {
  if (!f.engine && !f.modelCode && !f.source && !f.text) return true;
  if (!m) return false;
  if (f.engine && m.engine !== f.engine) return false;
  if (f.modelCode && m.modelCode !== f.modelCode) return false;
  if (f.source && m.source !== f.source) return false;
  if (f.text && !(m.prompt || "").toLowerCase().includes(f.text.toLowerCase())) return false;
  return true;
}

export function facetsOf(metas: Iterable<Meta | undefined>) {
  const models = new Map<string, { value: string; label: string; count: number }>();
  const engines = new Map<string, number>();
  const sources = new Map<string, number>();
  for (const m of metas) {
    if (!m) continue;
    if (m.modelCode) {
      const f = models.get(m.modelCode) ?? { value: m.modelCode, label: m.modelName || "", count: 0 };
      if (!f.label) f.label = m.modelName || "";
      f.count++;
      models.set(m.modelCode, f);
    }
    if (m.engine) engines.set(m.engine, (engines.get(m.engine) ?? 0) + 1);
    if (m.source) sources.set(m.source, (sources.get(m.source) ?? 0) + 1);
  }
  const sort = (a: { count: number; label: string }, b: { count: number; label: string }) =>
    a.count !== b.count ? b.count - a.count : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  return {
    models: [...models.values()].map((f) => ({ ...f, label: f.label || f.value })).sort(sort),
    engines: [...engines].map(([k, c]) => ({ value: k, label: k, count: c })).sort(sort),
    sources: [...sources].map(([k, c]) => ({ value: k, label: k, count: c })).sort(sort),
  };
}

function splitDataURL(s: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)(;base64)?,/.exec(s);
  if (!m || !m[2]) return null;
  const bin = atob(s.slice(m[0].length));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

function blobToDataURL(b: Blob, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;,]*/, "data:" + mime));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

function validName(name: string) {
  if (!name || /[\\/]/.test(name) || name.includes("..")) throw new Error("invalid image name");
}

// ------------------------------------------------------------- handles

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key: string, v: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(v, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  values?: () => AsyncIterable<FileSystemHandle>;
};

export const folderSupported = (): boolean => typeof (window as any).showDirectoryPicker === "function";

function storedMode(): GalleryMode {
  try {
    return localStorage.getItem(MODE_KEY) === "folder" ? "folder" : "browser";
  } catch {
    return "browser";
  }
}

let cachedRoot: DirHandle | null = null;
// The folder handle this page holds access to (picked, re-granted, or found
// granted); access lasts as long as the page.
let grantedFolder: DirHandle | null = null;
let metaCache: Map<string, Meta | undefined> | null = null;
const listeners = new Set<() => void>();

function changed() {
  metaCache = null;
  listeners.forEach((f) => f());
  window.dispatchEvent(new Event(GALLERY_CHANGED_EVENT));
}

/** Subscribe to gallery-location changes (folder picked, permission granted). */
export function onGalleryChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

async function browserRoot(): Promise<DirHandle> {
  const root = (await navigator.storage.getDirectory()) as DirHandle;
  return (await root.getDirectoryHandle("gallery", { create: true })) as DirHandle;
}

/** The writable gallery directory, or null when the folder needs a re-grant. */
async function root(): Promise<DirHandle | null> {
  if (cachedRoot) return cachedRoot;
  if (storedMode() === "folder") {
    const h = await idbGet<DirHandle>("gallery").catch(() => undefined);
    if (h) {
      const p = (await h.queryPermission?.({ mode: "readwrite" })) ?? "granted";
      if (p !== "granted") return null;
      return (cachedRoot = grantedFolder = h);
    }
  }
  return (cachedRoot = await browserRoot());
}

export async function galleryStatus(): Promise<GalleryStatus> {
  const mode = storedMode();
  if (mode === "folder") {
    // The folder this page was granted (picker or "Allow"): trust it — on
    // Chrome for Android a copy read back from IndexedDB can still answer
    // "prompt" right after the grant.
    if (grantedFolder) {
      return { mode, folderName: grantedFolder.name, needsPermission: false, folderSupported: folderSupported() };
    }
    const h = await idbGet<DirHandle>("gallery").catch(() => undefined);
    if (h) {
      const p = (await h.queryPermission?.({ mode: "readwrite" })) ?? "granted";
      return { mode, folderName: h.name, needsPermission: p !== "granted", folderSupported: folderSupported() };
    }
  }
  return { mode: "browser", folderName: "", needsPermission: false, folderSupported: folderSupported() };
}

/** Ask the user for a folder (must run in a click handler). Copies what the
 *  browser storage already holds into it, without overwriting. */
export async function chooseFolder(): Promise<GalleryStatus> {
  const pick = (window as any).showDirectoryPicker as (o: object) => Promise<DirHandle>;
  const h = await pick({ id: "imference-gallery", mode: "readwrite", startIn: "pictures" });
  const prev = await root().catch(() => null);
  await idbSet("gallery", h);
  localStorage.setItem(MODE_KEY, "folder");
  cachedRoot = grantedFolder = h;
  if (prev && prev !== h) await copyAll(prev, h);
  changed();
  return galleryStatus();
}

/** Re-grant access to the chosen folder (must run in a click handler). */
export async function reconnectFolder(): Promise<GalleryStatus> {
  const h = await idbGet<DirHandle>("gallery");
  if (h && (await h.requestPermission?.({ mode: "readwrite" })) === "granted") {
    cachedRoot = grantedFolder = h;
    changed();
  }
  return galleryStatus();
}

/** Switch back to the browser's own storage (the folder keeps its files). */
export async function useBrowserStorage(): Promise<GalleryStatus> {
  localStorage.setItem(MODE_KEY, "browser");
  cachedRoot = grantedFolder = null;
  changed();
  return galleryStatus();
}

async function copyAll(from: DirHandle, to: DirHandle) {
  for await (const e of from.values!()) {
    if (e.kind !== "file") continue;
    const exists = await to.getFileHandle(e.name).then(() => true, () => false);
    if (exists) continue;
    const f = await (e as FileSystemFileHandle).getFile();
    await writeFile(to, e.name, f);
  }
}

async function writeFile(dir: DirHandle, name: string, data: Blob | Uint8Array | string) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as any).createWritable();
  await w.write(data);
  await w.close();
}

async function requireRoot(): Promise<DirHandle> {
  const r = await root();
  if (!r) throw new Error("gallery folder access needs to be re-granted (Settings > Gallery)");
  return r;
}

// ------------------------------------------------------------- gallery API

async function files(dir: DirHandle): Promise<{ name: string; file: File }[]> {
  const out: { name: string; file: File }[] = [];
  for await (const e of dir.values!()) {
    if (e.kind === "file" && EXT_KIND[extOf(e.name)]) {
      out.push({ name: e.name, file: await (e as FileSystemFileHandle).getFile() });
    }
  }
  return out;
}

async function readMeta(dir: DirHandle, name: string): Promise<Meta | undefined> {
  try {
    const f = await (await dir.getFileHandle(name + ".json")).getFile();
    return JSON.parse(await f.text());
  } catch {
    return undefined;
  }
}

async function metas(dir: DirHandle, names: string[]): Promise<Map<string, Meta | undefined>> {
  if (metaCache && names.every((n) => metaCache!.has(n))) return metaCache;
  const m = new Map<string, Meta | undefined>();
  await Promise.all(names.map(async (n) => m.set(n, await readMeta(dir, n))));
  return (metaCache = m);
}

async function dims(file: File, kind: string): Promise<[number, number]> {
  if (kind !== "image") return [0, 0];
  try {
    const bmp = await createImageBitmap(file);
    const d: [number, number] = [bmp.width, bmp.height];
    bmp.close();
    return d;
  } catch {
    return [0, 0];
  }
}

export async function listSavedImages(offset: number, limit: number, filter: any) {
  const r = await root();
  if (!r) return [];
  let fs = await files(r);
  fs.sort((a, b) => b.file.lastModified - a.file.lastModified);
  const f = filter || {};
  const active = !!(f.engine || f.modelCode || f.source || f.text);
  const cache = await metas(r, fs.map((x) => x.name));
  if (active) fs = fs.filter((x) => matchFilter(cache.get(x.name), f));
  offset = Math.max(0, offset || 0);
  const end = limit > 0 ? Math.min(fs.length, offset + limit) : fs.length;
  return Promise.all(
    fs.slice(offset, end).map(async ({ name, file }) => {
      const kind = EXT_KIND[extOf(name)];
      const { source, seed } = parseSavedName(name);
      const meta = cache.get(name);
      let [w, h] = meta?.width && meta?.height ? [meta.width, meta.height] : await dims(file, kind);
      if (!w && meta?.width && meta?.height) [w, h] = [meta.width, meta.height];
      return { name, kind, source, seed, savedPath: name, width: w, height: h, meta };
    }),
  );
}

export async function galleryFacets() {
  const r = await root();
  if (!r) return facetsOf([]);
  const fs = await files(r);
  const cache = await metas(r, fs.map((x) => x.name));
  return facetsOf(fs.map((x) => cache.get(x.name)));
}

export async function getSavedImage(name: string): Promise<string> {
  validName(name);
  const r = await requireRoot();
  const f = await (await r.getFileHandle(name)).getFile();
  return blobToDataURL(f, EXT_MIME[extOf(name)] || f.type || "application/octet-stream");
}

export async function deleteSavedImage(name: string): Promise<void> {
  validName(name);
  const r = await requireRoot();
  await r.removeEntry(name);
  await r.removeEntry(name + ".json").catch(() => {});
  changed();
}

/** Metadata of a gallery file (for tools: the source image's prompt/model). */
export async function savedMeta(name: string): Promise<Meta | undefined> {
  validName(name);
  const r = await requireRoot();
  return readMeta(r, name);
}

/** Save a data URL + sidecar with the desktop naming; returns the file name. */
export async function saveDataURL(dataURL: string, source: string, seed: number, meta: Meta | undefined): Promise<string> {
  const d = splitDataURL(dataURL);
  if (!d) throw new Error("not a data URL");
  const r = await requireRoot();
  const ext = MIME_EXT[d.mime] || ".bin";
  const ts = stampOf(new Date());
  let name = "";
  for (let i = 1; i < 1000; i++) {
    const stamp = i > 1 ? `${ts}-${i}` : ts;
    name = `${stamp}_${sanitizeSource(source)}_${seed}${ext}`;
    const taken = await r.getFileHandle(name).then(() => true, () => false);
    if (!taken) break;
  }
  await writeFile(r, name, d.bytes);
  if (meta) await writeFile(r, name + ".json", JSON.stringify(meta, null, 2));
  changed();
  return name;
}
