// Web: tell the user a long run finished while they were in another tab —
// a system notification if they allowed it, and always a count in the tab
// title until they come back. (Desktop would need the native notification
// service of the Go side; not wired yet.)
import { useSyncExternalStore } from "react";
import { isWeb } from "./target";

const supported = () => isWeb && typeof window !== "undefined" && "Notification" in window;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** "default" (never asked), "granted", "denied", or "unsupported". */
export function useNotifyPermission(): NotificationPermission | "unsupported" {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (supported() ? Notification.permission : "unsupported"),
    () => "unsupported"
  );
}

/** Ask once, from a click (browsers refuse the prompt without a gesture). */
export async function requestNotify(): Promise<void> {
  if (!supported()) return;
  try {
    await Notification.requestPermission();
  } finally {
    emit();
  }
}

const away = () => document.hidden || !document.hasFocus();

let unseen = 0;
let baseTitle = "";
function badge() {
  if (!baseTitle) baseTitle = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = unseen > 0 ? `(${unseen}) ${baseTitle}` : baseTitle;
}
if (isWeb && typeof window !== "undefined") {
  const back = () => {
    if (away() || unseen === 0) return;
    unseen = 0;
    badge();
  };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
}

/** A run ended; only speaks up when the user isn't looking at the app. */
export function notifyFinished(title: string, body: string) {
  if (!isWeb || !away()) return;
  unseen += 1;
  badge();
  if (!supported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: "imference-run", icon: "./logo.svg" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some mobile browsers only notify from a service worker: the title count stays */
  }
}
