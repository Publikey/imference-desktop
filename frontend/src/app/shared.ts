// Small helpers and types shared by the App shell and its panels.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
export type Mode = "local" | "cloud";

// The composer's primary button: generate, or download the pending local model.
export type ComposerAction = {
  label: string;
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  kind: "generate" | "download";
  /** A click (or the shortcut) while disabled: point at what blocks it. */
  onBlocked?: () => void;
};

// What keeps Generate disabled, as [data-blocker] targets in the Create /
// Engine surfaces. A click on the disabled button scrolls to the first one and
// flashes them all (and focuses the prompt when it's empty).
export type Blocker = "edit-model" | "payment" | "model" | "readiness" | "prompt";
export function flagBlockers(targets: Blocker[]) {
  let first = true;
  for (const name of targets) {
    const el = document.querySelector<HTMLElement>(`[data-blocker="${name}"]`);
    if (!el) continue;
    if (first) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    first = false;
    el.classList.remove("blocker-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("blocker-flash");
    window.setTimeout(() => el.classList.remove("blocker-flash"), 1700);
  }
  if (targets.includes("prompt")) document.getElementById("composer-prompt")?.focus({ preventScroll: !first });
}

export let jobSeq = 0;
export const nextJobId = () => `job-${Date.now()}-${jobSeq++}`;

// True for a video payload — a data:video/... URL (in-memory or fetched bytes).
// Gallery rows also carry kind === "video" from the Go side; both signals are
// checked at render sites since fresh in-memory items may predate the kind.
export function isVideoSrc(src: string | null | undefined): boolean {
  return !!src && src.startsWith("data:video/");
}

// Read a picked/dropped File into a data-URL (the img2img source shape).
export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// In-app drags (gallery tile → Create panel for img2img) use POINTER events, not
// native HTML5 drag — WebKit/WKWebView (the macOS app's engine) doesn't fire
// drop/dragend reliably for in-page drags. The native path below handles only
// OS file drops (dragging an image file in from Finder), where "Files" is always
// exposed. See lib/pointer-drag.ts and startImageDrag.

// Set true for the moment after a pointer image-drag ends, so the click that may
// follow pointerup doesn't also open the lightbox / toggle selection.
// An object, not a let: the flag is set by App and read by the gallery tiles,
// which live in their own module (an imported binding is read-only).
export const tileClickGuard = { suppressed: false };

/** Opens the cloud call history (CloudHistoryDialog) from anywhere. */
export const OPEN_HISTORY_EVENT = "imference:open-history";

// True when a native (OS-originated) drag carries an image file we can drop.
export function dragHasImage(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes("Files");
}

export const WEB_DRAFT = "imference.web.prompt";

export function readWebDraft(): string {
  try {
    return sessionStorage.getItem(WEB_DRAFT) ?? "";
  } catch {
    return "";
  }
}

export function writeWebDraft(p: string) {
  try {
    sessionStorage.setItem(WEB_DRAFT, p);
  } catch {
    /* storage blocked: nothing to restore */
  }
}
