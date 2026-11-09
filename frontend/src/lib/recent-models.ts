// The models the user picked last, per mode (local / cloud), newest first, in
// this window's localStorage: a quick way back to them from the model card
// and the top of the picker.
import { useSyncExternalStore } from "react";

type Mode = "local" | "cloud";
const KEY = (m: Mode) => `imference.models.recent.${m}`;
const MAX = 6;

function read(m: Mode): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY(m)) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

const recent: Record<Mode, string[]> = { local: read("local"), cloud: read("cloud") };
const listeners = new Set<() => void>();

export function rememberModel(mode: Mode, code: string) {
  if (!code || recent[mode][0] === code) return;
  recent[mode] = [code, ...recent[mode].filter((c) => c !== code)].slice(0, MAX);
  try {
    localStorage.setItem(KEY(mode), JSON.stringify(recent[mode]));
  } catch {
    /* kept for this session only */
  }
  listeners.forEach((l) => l());
}

export function useRecentModels(mode: Mode): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => recent[mode],
    () => recent[mode]
  );
}
