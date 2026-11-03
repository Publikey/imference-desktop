import { useTranslation } from "react-i18next";
import { Brush, Images, Server, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PanelId } from "@/components/PanelBoard";

// ---------------------------------------------------------------------------
// PanelToggles — the header's show/hide switches for the main window's panels
// (Engine, Create, Edit, Gallery), in their own always-visible group like the
// panel toggles of Figma / VS Code. ⌘/Ctrl+1..4 does the same; the last
// visible panel cannot be switched off.
// ---------------------------------------------------------------------------

export const PANEL_ORDER: { id: PanelId; key: string }[] = [
  { id: "engine", key: "4" },
  { id: "create", key: "1" },
  { id: "edit", key: "2" },
  { id: "gallery", key: "3" },
];

export function PanelIcon({ id, className }: { id: PanelId; className?: string }) {
  const Icon = id === "create" ? Wand2 : id === "edit" ? Brush : id === "engine" ? Server : Images;
  return <Icon className={className} />;
}

export function PanelToggles({
  hidden,
  onToggle,
  modLabel,
}: {
  hidden: Partial<Record<PanelId, boolean>>;
  onToggle: (id: PanelId) => void;
  modLabel: string;
}) {
  const { t } = useTranslation();
  const visibleCount = PANEL_ORDER.filter((p) => !hidden[p.id]).length;
  return (
    <div
      role="group"
      aria-label={t("panels.toggleGroup")}
      className="ds-seg h-9"
    >
      {PANEL_ORDER.map(({ id, key }) => {
        const on = !hidden[id];
        const last = on && visibleCount === 1;
        const name = t(`panels.${id}`);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            disabled={last}
            onClick={() => onToggle(id)}
            title={
              (last ? t("panels.lastVisible") : t(on ? "panels.hide" : "panels.show", { name })) +
              ` (${modLabel}${key})`
            }
            // Shown = a raised thumb with full-strength text and icon; hidden =
            // flat, muted, with the icon dimmed — a toggle, not a tab.
            className={cn("ds-seg-item h-[30px] sm:px-3 disabled:cursor-not-allowed", !on && "[&_svg]:opacity-60")}
          >
            <PanelIcon id={id} className="size-3.5" />
            <span className="hidden lg:inline">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
