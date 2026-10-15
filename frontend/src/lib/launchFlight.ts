// launchFlight — the visible link between "I clicked Generate" and "it's in
// Activity": a small comet flies from the button that launched a run to the
// Activity widget, which reacts when it lands. The launching button plays its
// own burst first (it listens for LAUNCH_EVENT).

/** Window event fired when a run is launched; detail = { kind }. */
export const LAUNCH_EVENT = "imference:launch";
export type LaunchKind = "generate" | "tool";

const FLIGHT_MS = 720;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** The on-screen rect of the element that launched a `kind` run, if visible. */
function originRect(kind: LaunchKind): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[data-launch="${kind}"]`);
  const r = el?.getBoundingClientRect();
  if (!r || r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) return null;
  return r;
}

/**
 * Fly a comet from the `kind` launcher to `target`, then call `onArrive`.
 * Reduced motion (or no target): arrive at once, no flight.
 */
export function flyToActivity(
  kind: LaunchKind,
  target: HTMLElement | null,
  color: string,
  delay: number,
  onArrive: () => void
): void {
  window.dispatchEvent(new CustomEvent(LAUNCH_EVENT, { detail: { kind } }));
  if (!target || reducedMotion() || typeof document.body.animate !== "function") {
    window.setTimeout(onArrive, delay);
    return;
  }
  const from = originRect(kind);
  const to = target.getBoundingClientRect();
  const sx = from ? from.left + from.width / 2 : window.innerWidth / 2;
  const sy = from ? from.top + from.height / 2 : window.innerHeight / 2;
  const dx = to.left + to.width / 2 - sx;
  const dy = to.top + to.height / 2 - sy;
  // A quadratic arc lifted above the straight line, sampled into keyframes.
  const lift = Math.min(180, Math.hypot(dx, dy) * 0.4) + 40;
  const cx = dx / 2;
  const cy = dy / 2 - lift;
  const frames: Keyframe[] = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = 2 * (1 - t) * t * cx + t * t * dx;
    const y = 2 * (1 - t) * t * cy + t * t * dy;
    const scale = i === 0 ? 0.3 : i === N ? 0.45 : 1 + 0.35 * Math.sin(Math.PI * t);
    frames.push({ transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: i === N ? 0.6 : 1 });
  }

  // The head and two fading trail dots on the same path, a beat behind.
  const parts = [
    { cls: "launch-orb", lag: 0 },
    { cls: "launch-orb launch-orb-trail", lag: 45 },
    { cls: "launch-orb launch-orb-trail launch-orb-tail", lag: 90 },
  ].map(({ cls, lag }) => {
    const el = document.createElement("div");
    el.className = cls;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.style.setProperty("--orb", color);
    el.style.opacity = "0";
    document.body.appendChild(el);
    const anim = el.animate(frames, {
      duration: FLIGHT_MS,
      delay: delay + lag,
      easing: "cubic-bezier(0.45, 0, 0.7, 1)",
      fill: "forwards",
    });
    return { el, anim };
  });
  const cleanup = () => parts.forEach((p) => p.el.remove());
  parts[0].anim.onfinish = () => {
    onArrive();
    window.setTimeout(cleanup, 120);
  };
  parts[0].anim.oncancel = cleanup;
}
