// Gallery favorites: a set of saved-image file names, kept in this window's
// localStorage (desktop webview and web alike). Purely a view preference — the
// files themselves are untouched — so a lost store only loses the stars.
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "imference.gallery.favorites";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

let favorites = read();
const listeners = new Set<() => void>();

function commit(next: Set<string>) {
  favorites = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* storage blocked: the stars live for this session only */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function toggleFavorite(name: string) {
  const next = new Set(favorites);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  commit(next);
}

/** Forget deleted files, so the store never grows with names that are gone. */
export function forgetFavorites(names: Iterable<string>) {
  let changed = false;
  const next = new Set(favorites);
  for (const n of names) changed = next.delete(n) || changed;
  if (changed) commit(next);
}

/** The current favorite set; re-renders when it changes. */
export function useFavorites(): Set<string> {
  return useSyncExternalStore(subscribe, () => favorites, () => favorites);
}
