// The last prompts the user generated with, newest first, in this window's
// localStorage. Recorded when a run starts; a prompt used again moves to the
// top instead of appearing twice.
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "imference.prompts.recent";
const MAX = 20;

function read(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

let recent = read();
const listeners = new Set<() => void>();

export function rememberPrompt(prompt: string) {
  const p = prompt.trim();
  if (!p) return;
  recent = [p, ...recent.filter((x) => x !== p)].slice(0, MAX);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    /* kept for this session only */
  }
  listeners.forEach((l) => l());
}

export function useRecentPrompts(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => recent,
    () => recent
  );
}
