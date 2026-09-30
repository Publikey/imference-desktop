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
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
        {title}
        {optionalLabel && <span className="text-muted-foreground/50 normal-case">· {optionalLabel}</span>}
        {help && (
          <HoverPopover content={help} always className="inline-flex normal-case">
            <Info className="text-muted-foreground/60 hover:text-foreground size-3.5 cursor-help" />
          </HoverPopover>
        )}
      </span>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
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
      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-40"
    >
      <Plus className="size-3.5" strokeWidth={2.5} />
      {label}
    </button>
  );
}
