import { useTranslation } from "react-i18next";
import { Brush, Images, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PanelId } from "@/components/PanelBoard";

// ---------------------------------------------------------------------------
// PanelToggles — the header's show/hide switches for the main window's panels
// (Create, Edit, Gallery), in their own always-visible group like the panel
// toggles of Figma / VS Code. ⌘/Ctrl+1..3 does the same; the last visible
// panel cannot be switched off.
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
    <div
      role="group"
      aria-label={t("panels.toggleGroup")}
      className="bg-muted/50 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
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
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
              on
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60"
            )}
          >
            <PanelIcon id={id} className="size-3.5" />
            <span className="hidden md:inline">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
