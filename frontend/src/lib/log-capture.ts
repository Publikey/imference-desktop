// Frontend-side error/log capture: hooks console.* + window error events
// and forwards them to the Go logbus so the in-app LogPanel sees everything.
//
// The api.* method wrapping lives in wails-bridge.ts (so all importers of
// `api` get the wrapped version automatically — this file is only concerned
// with browser-emitted noise).
//
// Recursion guard: api.logFromFrontend may itself call console.* internally
// in some browsers (e.g. for Promise rejection diagnostics). The forwarding
// flag prevents an infinite loop if that ever happens.
import { api } from "./wails-bridge";
import type { LogLevel } from "./types";

let installed = false;
let forwarding = false;

/** Idempotent. Call once at app boot, before any other code runs. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  installConsoleCapture();
  installWindowErrorCapture();
}

function installConsoleCapture(): void {
  const map: Array<[keyof Console, LogLevel]> = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "trace"],
  ];
  for (const [method, level] of map) {
    const original = (console[method] as (...args: unknown[]) => void).bind(console);
    (console as unknown as Record<string, unknown>)[method as string] = (...args: unknown[]) => {
      original(...args);
      if (forwarding) return;
      forwarding = true;
      try {
        const message = args
          .map((a) => (typeof a === "string" ? a : safeJson(a)))
          .join(" ");
        // Wails v2 chokes on `null` for `any` params (reflect: Call using zero
        // Value argument). Send {} as a no-op payload instead.
        void api.logFromFrontend(level, "front:console", message, {});
      } finally {
        forwarding = false;
      }
    };
  }
}

function installWindowErrorCapture(): void {
  window.addEventListener("error", (e) => {
    void api.logFromFrontend("error", "front:uncaught", String(e.message), {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    void api.logFromFrontend("error", "front:unhandledrejection", message, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
