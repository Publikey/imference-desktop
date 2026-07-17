import { cn } from "@/lib/utils";

/**
 * The one determinate/indeterminate progress bar used app-wide (engine install,
 * model download, running generations). Pass a `percent` for a determinate
 * brand-filled bar; omit it (or pass null) for the indeterminate brand sweep.
 */
export function ProgressBar({
  percent,
  className,
  height = "h-1.5",
}: {
  percent?: number | null;
  className?: string;
  height?: string;
}) {
  const determinate = typeof percent === "number" && percent > 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(percent!) : undefined}
      className={cn("bg-muted w-full overflow-hidden rounded-full", height, className)}
    >
      {determinate ? (
        <div
          className="brand-surface h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, percent!))}%` }}
        />
      ) : (
        <div className="bar-indeterminate h-full w-full rounded-full" />
      )}
    </div>
  );
}
