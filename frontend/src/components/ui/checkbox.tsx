import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Brand-accented checkbox replacing the raw OS `<input type=checkbox>`. Keeps a
 * real (visually-hidden) input for a11y + form semantics; the visible box is a
 * styled sibling that fills with the brand gradient and shows a check when on.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  id,
  className,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="peer absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none flex size-4 items-center justify-center rounded-[5px] border transition-colors",
          "peer-focus-visible:ring-[var(--brand-from)]/40 peer-focus-visible:ring-2 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
          checked
            ? "brand-surface border-transparent text-white"
            : "border-input bg-background peer-hover:border-[var(--brand-from)]/50"
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
    </span>
  );
}
