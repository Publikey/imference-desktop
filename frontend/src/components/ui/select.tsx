import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A styled wrapper over a native <select> — keeps the native menu (accessible,
 * zero-dependency) but removes the OS chrome and adds the app's border, focus
 * ring, and a chevron. The one select primitive used across settings, runtime
 * tuning, the logs filters, and the gallery facet filters.
 */
export function Select({
  value,
  onChange,
  children,
  className,
  fullWidth,
  size = "md",
  id,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  /** Extra classes for the wrapper (e.g. `max-w-40`). */
  className?: string;
  /** Stretch to the container width (block selects in settings/runtime). */
  fullWidth?: boolean;
  size?: "sm" | "md";
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const sm = size === "sm";
  return (
    <div className={cn("relative", fullWidth ? "w-full" : "inline-block", className)}>
      <select
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "border-input bg-background hover:border-primary/40 focus-visible:ring-[var(--brand-from)]/30 w-full appearance-none rounded-md border transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
          sm ? "h-7 pl-2.5 pr-7 text-xs" : "h-9 pl-2.5 pr-8 text-sm"
        )}
      >
        {children}
      </select>
      <ChevronDown
        className={cn(
          "text-muted-foreground pointer-events-none absolute top-1/2 -translate-y-1/2",
          sm ? "right-1.5 size-3.5" : "right-2 size-4"
        )}
      />
    </div>
  );
}
