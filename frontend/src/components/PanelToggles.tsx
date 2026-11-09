import { useTranslation } from "react-i18next";
import { Brush, Images, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SegGroup, SegItem } from "@/components/ds";
import type { PanelId } from "@/components/PanelBoard";

// ---------------------------------------------------------------------------
// PanelToggles — the header's show/hide switches for the main window's panels
// (Create, Edit, Gallery), in their own always-visible group like the
// panel toggles of Figma / VS Code. ⌘/Ctrl+1..3 does the same; the last
// visible panel cannot be switched off.
// ---------------------------------------------------------------------------

export const PANEL_ORDER: { id: PanelId; key: string }[] = [
  { id: "create", key: "1" },
  { id: "edit", key: "2" },
  { id: "gallery", key: "3" },
];

export function PanelIcon({ id, className }: { id: PanelId; className?: string }) {
  const Icon = id === "create" ? Wand2 : id === "edit" ? Brush : Images;
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
    <SegGroup label={t("panels.toggleGroup")} className="panel-toggles h-9 max-sm:hidden">
      {PANEL_ORDER.map(({ id, key }) => {
        const on = !hidden[id];
        const last = on && visibleCount === 1;
        const name = t(`panels.${id}`);
        return (
          <SegItem
            key={id}
            kind="toggle"
            on={on}
            disabled={last}
            onClick={() => onToggle(id)}
            title={
              (last ? t("panels.lastVisible") : t(on ? "panels.hide" : "panels.show", { name })) +
              ` (${modLabel}${key})`
            }
            // Shown = a raised thumb with full-strength text and icon; hidden =
            // flat, muted, with the icon dimmed — a toggle, not a tab.
            className={cn("h-[30px] sm:px-3 disabled:cursor-not-allowed", !on && "[&_svg]:opacity-60")}
          >
            <PanelIcon id={id} className="size-3.5" />
            <span className="hidden lg:inline">{name}</span>
          </SegItem>
        );
      })}
    </SegGroup>
  );
}
