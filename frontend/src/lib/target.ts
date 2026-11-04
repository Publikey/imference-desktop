// Build target: "web" for the browser build (npm run build:web), else desktop.
export const isWeb = import.meta.env.MODE === "web";

// Web build: window event fired when the gallery's location changes (a folder
// picked, its access granted again, back to browser storage), so the gallery
// reloads in place. Never a page reload: Chrome on Android drops a folder's
// access on reload, which made "Allow access" come back in a loop.
export const GALLERY_CHANGED_EVENT = "imference:gallery-changed";

/** Settings changed outside App (a key adopted after a purchase): reload them. */
export const SETTINGS_CHANGED_EVENT = "imference:settings-changed";
export function notifySettingsChanged() {
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

/** Opens Settings at a section ("x402", "apikey", "cloud") from outside App. */
export const OPEN_SETTINGS_EVENT = "imference:open-settings";
export function openSettingsAt(section: string) {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section }));
}

/** The paying balance may have moved (credits bought, a cloud run paid):
 *  every balance readout re-reads it. */
export const BALANCE_CHANGED_EVENT = "imference:balance-changed";
export function notifyBalanceChanged() {
  window.dispatchEvent(new Event(BALANCE_CHANGED_EVENT));
}

/** Re-runs `refresh` when the balance may have moved, or the window comes
 *  back into focus (a top-up made on imference.com, another device). */
export function onBalanceMaybeChanged(refresh: () => void): () => void {
  window.addEventListener(BALANCE_CHANGED_EVENT, refresh);
  window.addEventListener("focus", refresh);
  return () => {
    window.removeEventListener(BALANCE_CHANGED_EVENT, refresh);
    window.removeEventListener("focus", refresh);
  };
}

/** Opens the cloud call history (CloudHistoryDialog, mounted in App). */
export const OPEN_HISTORY_EVENT = "imference:open-history";
export function openCloudHistory() {
  window.dispatchEvent(new Event(OPEN_HISTORY_EVENT));
}
