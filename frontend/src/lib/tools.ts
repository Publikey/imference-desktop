// Editing tools — shared renderer helpers: the tool list (with this machine's
// badges, refreshed when the engine state changes), menu groupings, param
// defaults and progress-stage labels. The Go side (app_tools.go) owns routing.
import { useEffect, useState } from "react";
import { api } from "@/lib/wails-bridge";
import type { ToolInfo, ToolParamSpec } from "@/lib/types";

/** The image tools offered first in the gallery's Edit menus, in order. */
export const EDIT_TOOL_IDS = [
  "upscale",
  "vary",
  "remove-background",
  "erase-object",
  "segment",
  "outpaint",
  "restore-faces",
  "describe",
] as const;

/** Image utilities, behind "More tools…". */
export const UTILITY_TOOL_IDS = ["inpaint", "resize", "crop", "convert", "strip-metadata"] as const;

/** Tools offered on a video item. */
export const VIDEO_TOOL_IDS = ["video-trim", "video-convert", "interpolate", "video-concat"] as const;

/** Tools that open the mask editor (paint or click-to-select what to change). */
export const MASK_TOOL_IDS = new Set(["erase-object", "inpaint", "segment"]);

/** Params the dialog never renders as plain fields (handled by a custom UI or
 *  filled by the app). */
export const HIDDEN_PARAMS: Record<string, Set<string>> = {
  vary: new Set(["model"]),
  inpaint: new Set(["model"]),
  outpaint: new Set(["model", "left", "right", "top", "bottom"]),
  segment: new Set(["points"]),
};

let cache: ToolInfo[] | null = null;
const listeners = new Set<(t: ToolInfo[]) => void>();
let inflight: Promise<ToolInfo[]> | null = null;

function publish(list: ToolInfo[]) {
  cache = list;
  listeners.forEach((l) => l(list));
}

/** Re-read the tool list (badges depend on the engine + loaded model). */
export function refreshTools(probe = false): Promise<ToolInfo[]> {
  if (inflight && !probe) return inflight;
  const p = (probe ? api.probeTools() : api.listTools())
    .then((list) => {
      publish(list ?? []);
      return list ?? [];
    })
    .catch(() => cache ?? [])
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  if (!probe) inflight = p;
  return p;
}

/** The tool list, kept fresh across engine state changes. */
export function useTools(): ToolInfo[] {
  const [list, setList] = useState<ToolInfo[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (!cache) void refreshTools();
    // The generation sidecar's state drives the generation tools' badges.
    const off = api.onSidecarStatus(() => void refreshTools());
    return () => {
      listeners.delete(setList);
      off();
    };
  }, []);
  return list;
}

export function toolById(list: ToolInfo[], id: string): ToolInfo | undefined {
  return list.find((t) => t.id === id);
}

/** Starting values for a tool's form: the manifest defaults. */
export function defaultParams(tool: ToolInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of tool.params) {
    if (p.default !== undefined && p.default !== null) out[p.name] = p.default;
  }
  return out;
}

/** Coerce a form value to the param's type ("" = unset). */
export function coerceParam(p: ToolParamSpec, raw: string): unknown {
  if (raw === "") return undefined;
  switch (p.type) {
    case "int": {
      const n = Math.round(Number(raw));
      return Number.isFinite(n) ? n : undefined;
    }
    case "float": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "enum": {
      const hit = (p.values ?? []).find((v) => String(v) === raw);
      return hit ?? raw;
    }
    default:
      return raw;
  }
}

export function newToolJobId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "tool_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Stage → i18n key ("tools.stage.<stage>"); unknown stages fall back to running. */
export const KNOWN_STAGES = new Set([
  "starting",
  "downloading_weights",
  "loading",
  "running",
  "encoding",
  "uploading",
  "queued",
  "downloading",
]);

/** Load a data URL (or any src) into an HTMLImageElement. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}
