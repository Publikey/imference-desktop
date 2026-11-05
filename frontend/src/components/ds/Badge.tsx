import type * as React from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const TONE: Record<BadgeTone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  brand: "border-[color-mix(in_oklch,var(--brand-to)_35%,transparent)] bg-[color-mix(in_oklch,var(--brand-to)_12%,transparent)] text-foreground",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
};

/**
 * The one small status pill (engine installed, tool runs locally / in the
 * cloud, dev build…). `overlay` is the variant laid over an image (price, NSFW
 * on a model card): opaque, with a shadow, whatever colour `className` gives.
 */
export function Badge({
  tone = "neutral",
  overlay = false,
  className,
  children,
  ...rest
}: {
  tone?: BadgeTone;
  overlay?: boolean;
} & React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-2xs font-medium [&_svg]:size-3",
        overlay ? "font-semibold shadow-sm" : cn("border", TONE[tone]),
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
