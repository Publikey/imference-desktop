import * as React from "react";
import { SegGroup, SegItem } from "@/components/ds";
import { cn } from "@/lib/utils";

export type SegmentedItem<T extends string> = {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
};

/**
 * Items-based one-of-n switch (payment method, editor modes, crop ratios).
 * Rendered with the design system's segmented control (.ds-seg, as
 * components/ds Segmented), so there is one look for every switch in the app;
 * this keeps the items/size/wrap API its callers use. Items flex equally;
 * `wrap` keeps a min basis so a narrow panel breaks to 2 rows instead of
 * overflowing.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  wrap = false,
  className,
  size = "md",
  label,
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Allow buttons to wrap to a second row (narrow panels). */
  wrap?: boolean;
  className?: string;
  size?: "sm" | "md";
  /** Accessible name of the group. */
  label?: string;
}) {
  return (
    <SegGroup
      role="radiogroup"
      label={label ?? ""}
      className={cn(wrap ? "flex flex-wrap" : "inline-flex", className)}
    >
      {items.map((it) => (
        <SegItem
          key={it.value}
          on={it.value === value}
          title={it.title}
          onClick={() => onChange(it.value)}
          className={cn(
            "flex-1 whitespace-nowrap",
            size === "md" && "h-8 px-3 text-sm",
            wrap && "basis-[4.5rem]"
          )}
        >
          {it.icon}
          {it.label}
        </SegItem>
      ))}
    </SegGroup>
  );
}
