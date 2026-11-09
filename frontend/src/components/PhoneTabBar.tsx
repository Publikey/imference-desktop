import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { PanelId } from "@/components/PanelBoard";
import { PANEL_ORDER, PanelIcon } from "@/components/PanelToggles";

// ---------------------------------------------------------------------------
// Phones: one panel at a time, picked from a tab bar under the thumb, instead
// of Create, Edit and Gallery stacked in one long scroll (the gallery started
// a full screen below the run button). Same breakpoint as Tailwind's `sm`, and
// as --phone-nav-h in index.css, which lifts the fixed chrome above the bar.
// ---------------------------------------------------------------------------

const PHONE_QUERY = "(max-width: 639px)";
const media = typeof window !== "undefined" ? window.matchMedia?.(PHONE_QUERY) : undefined;

function subscribe(l: () => void) {
  media?.addEventListener("change", l);
  return () => media?.removeEventListener("change", l);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => !!media?.matches, () => false);
}

export function PhoneTabBar({ tab, onTab }: { tab: PanelId; onTab: (id: PanelId) => void }) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("panels.toggleGroup")}
      className="phone-tabbar fixed inset-x-0 bottom-0 z-40 flex border-t px-2 pt-1 sm:hidden"
    >
      {PANEL_ORDER.map(({ id }) => {
        const on = tab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onTab(id)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-2xs font-medium transition-colors",
              on ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <span className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", on && "phone-tab-on")}>
              <PanelIcon id={id} className="size-[1.125rem]" />
            </span>
            {t(`panels.${id}`)}
          </button>
        );
      })}
    </nav>
  );
}
