import { Info, Plus } from "lucide-react";
import { HoverPopover } from "@/components/ui/hover-popover";

// Shared pieces of the optional composer cards (reference image, LoRAs): one
// header shape — title, "· optional", an info tooltip instead of a paragraph of
// explanation — and one "Add" button, so the two cards read as siblings.

export function ComposerCardHeader({
  title,
  optionalLabel,
  help,
  action,
}: {
  title: string;
  /** "optional" — both cards are, and an empty card must not read as missing input. */
  optionalLabel?: string;
  /** Shown on hover of the info icon. */
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

/** Secondary field label inside a card (negative prompt, quality tags…): the
 *  header's style one step quieter, with the same info tooltip. */
export function FieldLabel({
  label,
  help,
  htmlFor,
}: {
  label: string;
  help?: string;
  htmlFor?: string;
}) {
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="ds-chip-btn"
    >
      <Plus className="size-3.5" strokeWidth={2.5} />
      {label}
    </button>
  );
}
