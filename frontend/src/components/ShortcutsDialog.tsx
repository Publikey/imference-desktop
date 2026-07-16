import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { modLabel } from "@/components/CommandPalette";

// A discoverable cheat-sheet of the app's keyboard shortcuts. Opened with "?"
// (also from the command palette). Keys are literal; only the labels are i18n.
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const mod = modLabel;

  const sections: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
      title: t("shortcuts.general"),
      rows: [
        { keys: [mod, "K"], label: t("shortcuts.palette") },
        { keys: ["?"], label: t("shortcuts.help") },
        { keys: [mod, "↵"], label: t("shortcuts.generate") },
      ],
    },
    {
      title: t("shortcuts.gallery"),
      rows: [
        { keys: [`${mod}+${t("shortcuts.click")}`], label: t("shortcuts.multiSelect") },
        { keys: [`⇧+${t("shortcuts.click")}`], label: t("shortcuts.rangeSelect") },
        { keys: [mod, "A"], label: t("shortcuts.selectAll") },
        { keys: ["Del"], label: t("shortcuts.deleteSel") },
        { keys: ["Esc"], label: t("shortcuts.clearSel") },
        { keys: [t("shortcuts.rightClick")], label: t("shortcuts.context") },
      ],
    },
    {
      title: t("shortcuts.viewer"),
      rows: [
        { keys: ["←", "→"], label: t("shortcuts.prevNext") },
        { keys: [t("shortcuts.click")], label: t("shortcuts.zoom") },
        { keys: ["Esc"], label: t("shortcuts.close") },
      ],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-3">
          {sections.map((s) => (
            <div key={s.title} className="min-w-0">
              <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wide">
                {s.title}
              </h3>
              <dl className="space-y-2">
                {s.rows.map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground text-xs">{r.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k) => (
                        <Fragment key={k}>
                          <kbd className="bg-muted text-foreground inline-flex h-5 min-w-5 items-center justify-center rounded border px-1.5 text-[11px] font-medium">
                            {k}
                          </kbd>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
