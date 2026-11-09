// Whether a `position: sticky` element is currently stuck to its edge, for
// styling it only then (a frosted band that would otherwise sit, visible and
// pointless, in the middle of a short column).
//
// A 1px sentinel sits just outside the element, before it for a top-stuck bar
// and after it for a bottom-stuck one; the bar is stuck exactly when that
// sentinel lies past the edge of the box that scrolls.
//
// Measured on scroll (once per frame), not with an IntersectionObserver: the
// observer only reports crossings of the visible area, and a sentinel that
// jumps from below the fold to above it (a long column, a fling) crosses none.
import { useEffect, useRef, useState } from "react";

// The nearest ancestor that actually scrolls (the board column on wide
// windows, <main> below) — the box a sticky child sticks inside.
function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

export function useStuck(edge: "top" | "bottom") {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const bar = barRef.current;
    if (!sentinel || !bar) return;
    let root: HTMLElement | null = null;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      // The bar's own offset moves the edge it sticks to (top: 3.5rem lowers
      // it; bottom: -1.5rem, sticking into the column's padding, lowers it too).
      const offset = parseFloat(getComputedStyle(bar)[edge]) || 0;
      const r = sentinel.getBoundingClientRect();
      setStuck(edge === "top" ? r.bottom <= box.top + offset : r.top >= box.bottom - offset);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const attach = () => {
      (root ?? window).removeEventListener("scroll", schedule);
      // The layout (and so the box that scrolls) changes at breakpoints.
      root = scrollParent(sentinel);
      (root ?? window).addEventListener("scroll", schedule, { passive: true });
      schedule();
    };
    attach();
    window.addEventListener("resize", attach);
    // Content growing or shrinking moves the sentinel without any scroll.
    const ro = new ResizeObserver(schedule);
    ro.observe(bar.parentElement ?? bar);
    return () => {
      window.removeEventListener("resize", attach);
      (root ?? window).removeEventListener("scroll", schedule);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [edge]);
  return { sentinelRef, barRef, stuck };
}
