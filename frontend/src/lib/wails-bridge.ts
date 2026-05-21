// Thin typed facade over the auto-generated Wails bindings. Two purposes:
// 1. give the renderer a single import surface (`api`) regardless of how
//    Wails reshapes the generated files between versions;
// 2. let us evolve the camelCase / snake_case shape with explicit casts at
//    one place, so the React components never reach into wailsjs/.
import {
  GenerateCloud,
  GenerateLocal,
  GetSettings,
  GetSidecarStatus,
  RestartSidecar,
  SaveSettings,
} from "../../wailsjs/go/main/App";
import { EventsOff, EventsOn } from "../../wailsjs/runtime/runtime";
import type {
  AppSettings,
  GenerationRequest,
  GenerationResult,
  SidecarStatus,
} from "./types";

// Wails-generated functions are typed as (anyOfTheArgs) => Promise<any>.
// The casts here give the rest of the app the strict shapes from types.ts
// without polluting every callsite.
export const api = {
  getSettings: GetSettings as () => Promise<AppSettings>,
  saveSettings: SaveSettings as (next: AppSettings) => Promise<AppSettings>,
  getSidecarStatus: GetSidecarStatus as () => Promise<SidecarStatus>,
  restartSidecar: RestartSidecar as () => Promise<void>,
  generateCloud: GenerateCloud as (req: GenerationRequest) => Promise<GenerationResult>,
  generateLocal: GenerateLocal as (req: GenerationRequest) => Promise<GenerationResult>,
  onSidecarStatus: (cb: (s: SidecarStatus) => void): (() => void) => {
    // Wails has no per-handler removal (only EventsOff(eventName)). Since
    // the renderer only ever wires one listener for sidecar:status, that's
    // safe — but if a second component ever subscribes, the cleanup will
    // remove both. Track it here when that day comes.
    EventsOn("sidecar:status", (s: SidecarStatus) => cb(s));
    return () => EventsOff("sidecar:status");
  },
};
