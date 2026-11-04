import type * as React from "react";
import { Info, Plus } from "lucide-react";
import { HoverPopover } from "@/components/ui/hover-popover";
import { cn } from "@/lib/utils";

// Section — the one bordered surface inside a board panel (.ds-card), with
// an optional header: title, "optional" note, info tooltip, right-aligned
// action. Every section of the Engine / Create / Edit panels uses it, so they
// share edges, padding and title style.

export function SectionHeader({
  title,
  optionalLabel,
  help,
  action,
}: {
  title: React.ReactNode;
  /** "optional" — an empty optional section must not read as missing input. */
  optionalLabel?: string;
  /** Shown on hover of the info icon, instead of a paragraph of explanation. */
  help?: string;
  /** Right-aligned control (Add / Clear). */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <span className="ds-label">
        {title}
        {optionalLabel && <span className="ds-hint">{optionalLabel}</span>}
        {help && (
          <HoverPopover content={help} always className="inline-flex">
            <Info className="text-subtle hover:text-foreground size-3.5 cursor-help transition-colors" />
          </HoverPopover>
        )}
      </span>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

export function Section({
  title,
  optionalLabel,
  help,
  action,
  className,
  children,
  ...rest
}: {
  title?: React.ReactNode;
  optionalLabel?: string;
  help?: string;
  action?: React.ReactNode;
} & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section className={cn("ds-card px-4 py-3", className)} {...rest}>
      {title !== undefined && <SectionHeader title={title} optionalLabel={optionalLabel} help={help} action={action} />}
      {children}
    </section>
  );
}

/** A field's label inside a section (negative prompt, quality tags…): the
 *  section title one step quieter, with the same info tooltip. */
export function FieldLabel({ label, help, htmlFor }: { label: string; help?: string; htmlFor?: string }) {
  return (
    <span className="ds-sublabel mb-1.5">
      <label htmlFor={htmlFor} className="cursor-text">
        {label}
      </label>
      {help && (
        <HoverPopover content={help} always className="inline-flex">
          <Info className="text-subtle hover:text-foreground size-3 cursor-help transition-colors" />
        </HoverPopover>
      )}
    </span>
  );
}

/** A labelled field: FieldLabel above any control (pass the control's id). */
export function Field({
  label,
  help,
  htmlFor,
  className,
  children,
}: {
  label: string;
  help?: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <FieldLabel label={label} help={help} htmlFor={htmlFor} />
      {children}
    </div>
  );
}

/** The small secondary pill action of a section header ("Add"). */
export function AddButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className="ds-chip-btn">
      <Plus className="size-3.5" strokeWidth={2.5} />
      {label}
    </button>
  );
}
