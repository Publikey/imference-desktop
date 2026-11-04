// Theme preference: "system" (default) follows the OS appearance live;
// "light" / "dark" are explicit overrides persisted in localStorage — the same
// split as the language choice in i18n.ts, and kept out of settings.json for
// the same reason (pure UI concern, no Go round-trip before first paint).

import { SetAppearance } from "../../bindings/imference-desktop-go/app";
import { isWeb } from "./target";

export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "imference.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let pref: ThemePref = read();

/** Whether the app is dark right now (the preference resolved against the OS). */
export function isDark(): boolean {
  return pref === "dark" || (pref === "system" && media.matches);
}

let reported: boolean | null = null;

function apply(): void {
  const dark = isDark();
  document.documentElement.classList.toggle("dark", dark);
  // Desktop: the native window background follows (app_appearance.go), and
  // the next launch opens in this colour. Only on a change.
  if (!isWeb && reported !== dark) {
    reported = dark;
    SetAppearance(dark).catch(() => {});
  }
}

/** Current preference (React: pair with subscribeTheme via useSyncExternalStore). */
export function themePref(): ThemePref {
  return pref;
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Persist a choice ("system" clears the override) and restyle immediately. */
export function setThemePref(p: ThemePref): void {
  pref = p;
  try {
    if (p === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, p);
  } catch {
    // storage unavailable — the in-memory switch below still applies
  }

  // Cross-fade the palette on a MANUAL switch only (system-driven flips happen
  // while the app is unfocused, and initial load must not animate). The class
  // arms a short global color transition, removed once it has played.
  const root = document.documentElement;
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 300);
  }

  apply();
  listeners.forEach((l) => l());
}

/** Apply the stored preference and start following the OS while on "system". */
export function initTheme(): void {
  apply();
  media.addEventListener("change", () => {
    if (pref !== "system") return;
    apply();
    listeners.forEach((l) => l());
  });
}
