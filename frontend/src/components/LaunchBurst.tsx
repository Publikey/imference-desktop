import { useEffect, useState } from "react";
import { LAUNCH_EVENT, type LaunchKind } from "@/lib/launchFlight";

/**
 * Counts launches of `kind` (a run actually queued — not a disabled click):
 * the button keys its animations on it so they replay on every launch, from a
 * click or a keyboard shortcut alike.
 */
export function useLaunchBurst(kind: LaunchKind): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ kind: LaunchKind }>).detail?.kind === kind) setN((v) => v + 1);
    };
    window.addEventListener(LAUNCH_EVENT, on);
    return () => window.removeEventListener(LAUNCH_EVENT, on);
  }, [kind]);
  return n;
}

/** Two rings bursting out of the launching button (place in a relative box). */
export function LaunchBurst({ burst }: { burst: number }) {
  if (burst === 0) return null;
  return (
    <>
      <span key={`a-${burst}`} aria-hidden className="launch-ring pointer-events-none absolute inset-0 rounded-[inherit]" />
      <span key={`b-${burst}`} aria-hidden className="launch-ring launch-ring-late pointer-events-none absolute inset-0 rounded-[inherit]" />
    </>
  );
}
