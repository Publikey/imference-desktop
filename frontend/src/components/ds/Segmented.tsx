import type * as React from "react";
import { cn } from "@/lib/utils";

// Segmented controls (.ds-seg / .ds-seg-item): a sunken track whose "on"
// items are raised thumbs. Two semantics, one look:
//   - radio: exactly one option (mode, column count) -> <Segmented>
//   - toggle: each item on or off independently (panel switches)
//     -> <SegGroup> + <SegItem kind="toggle">

export function SegGroup({
  label,
  role = "group",
  className,
  children,
}: {
  /** Accessible name of the group. */
  label: string;
  role?: "group" | "radiogroup";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role={role} aria-label={label} className={cn("ds-seg", className)}>
      {children}
    </div>
  );
}

export function SegItem({
  on,
  kind = "radio",
  className,
  ...props
}: {
  on: boolean;
  kind?: "radio" | "toggle";
} & React.ComponentProps<"button">) {
  const state = kind === "radio" ? { role: "radio" as const, "aria-checked": on } : { "aria-pressed": on };
  return <button type="button" {...state} {...props} className={cn("ds-seg-item", className)} />;
}

export type SegOption<T extends string | number> = {
  value: T;
  label: React.ReactNode;
  /** Accessible name / tooltip when the label is short or an icon. */
  title?: string;
  disabled?: boolean;
  className?: string;
};

/** One-of-n choice. `leading` is a decoration before the options (an icon). */
export function Segmented<T extends string | number>({
  label,
  value,
  onChange,
  options,
  leading,
  className,
  itemClassName,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  leading?: React.ReactNode;
  className?: string;
  itemClassName?: string;
}) {
  return (
    <SegGroup label={label} role="radiogroup" className={className}>
      {leading}
      {options.map((o) => (
        <SegItem
          key={String(o.value)}
          on={o.value === value}
          disabled={o.disabled}
          title={o.title}
          aria-label={o.title}
          onClick={() => onChange(o.value)}
          className={cn(itemClassName, o.className)}
        >
          {o.label}
        </SegItem>
      ))}
    </SegGroup>
  );
}
