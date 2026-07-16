import { cn } from "@/lib/utils";

/** A shimmering placeholder box. Styling lives in `.skeleton` (index.css) so the
 *  shimmer is reduced-motion-guarded in one place. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} />;
}
