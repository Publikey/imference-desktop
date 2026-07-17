import * as React from "react";
import { cn } from "@/lib/utils";

export type SegmentedItem<T extends string> = {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
};

/**
 * The one canonical small segmented control used across the app (format picker,
 * payment method, dialog tabs). Container `rounded-xl p-1`, thumb `rounded-lg` —
 * one radius step apart, so the active pill sits evenly in its track. Items flex
 * equally and wrap; `wrap` keeps a min basis so a narrow panel breaks to 2 rows
 * instead of overflowing.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  wrap = false,
  className,
  size = "md",
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Allow buttons to wrap to a second row (narrow panels). */
  wrap?: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "bg-muted inline-flex items-center gap-1 rounded-xl p-1",
        wrap && "flex flex-wrap",
        className
      )}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={it.title}
            onClick={() => onChange(it.value)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-200",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              wrap && "basis-[4.5rem]",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
