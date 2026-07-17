// Pointer-event drag, used instead of HTML5 native drag-and-drop for in-app
// interactions (panel reorder, gallery→img2img). WebKit / WKWebView — the macOS
// desktop app's engine — does not fire `drop`/`dragend` reliably for in-page
// native drags, so anything that depends on them silently fails there. Pointer
// events are fully supported everywhere, so this works uniformly.
//
// A drag only "activates" once the pointer moves past a small threshold, so a
// plain click on the same element is still a click (the caller distinguishes via
// the `moved` flag passed to onEnd).

export type PointerDragHandlers = {
  /** Pixels of movement before the drag activates (default 6). */
  threshold?: number;
  /** Fired once, when the drag first activates (threshold crossed). */
  onStart?: () => void;
  /** Fired on every move after activation, with viewport coords. */
  onMove: (x: number, y: number) => void;
  /** Fired on release/cancel. `moved` is true iff the drag had activated. */
  onEnd: (x: number, y: number, moved: boolean) => void;
};

export function beginPointerDrag(
  e: { button: number; clientX: number; clientY: number },
  h: PointerDragHandlers
) {
  if (e.button !== 0) return; // primary button only
  const startX = e.clientX;
  const startY = e.clientY;
  const threshold = h.threshold ?? 6;
  let active = false;

  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < threshold) return;
      active = true;
      document.body.style.userSelect = "none";
      h.onStart?.();
    }
    ev.preventDefault();
    h.onMove(ev.clientX, ev.clientY);
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    document.body.style.userSelect = "";
    h.onEnd(ev.clientX, ev.clientY, active);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}
