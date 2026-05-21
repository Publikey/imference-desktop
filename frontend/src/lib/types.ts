// Mirrors internal/types/types.go. Once `wails dev` has run once we *could*
// instead `import type { main } from "../../wailsjs/go/models"` for the
// generated equivalents, but those bindings don't exist until first build
// and this keeps the renderer typecheck self-contained.

export type AppSettings = {
  apiKey: string;
  pythonPath: string;
  sdxlPath: string;
  cloudModel: string;
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
};

export type SidecarStatus =
  | { state: "idle" }
  | { state: "starting"; port: number }
  | { state: "ready"; port: number; device: string }
  | { state: "error"; message: string }
  | { state: "stopped" };
