// First-run setup card (install the local engine, or use the cloud).
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { LocalEngineSection } from "@/components/LocalEngineSection";
import { ChevronRight, Cloud, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// FirstRunSetup — a guided welcome shown in the Create panel on first run (no
// local engine AND no cloud payment configured). Reuses LocalEngineSection for
// the install step; offers the cloud path as an alternative; skippable. As soon
// as either path completes, `firstRun` flips false and the normal composer
// returns — this component doesn't drive that transition itself.
// ---------------------------------------------------------------------------
export function FirstRunSetup({
  onInstallDone,
  onOpenCloudSettings,
  onSkip,
}: {
  onInstallDone: () => void;
  onOpenCloudSettings: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="ds-card relative overflow-hidden p-4">
      <div className="canvas-glow pointer-events-none absolute inset-0" />
      <div className="relative flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="brand-surface flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-[0_8px_24px_-8px_color-mix(in_oklch,var(--brand-to)_60%,transparent)]">
            <Sparkles className="size-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t("onboarding.title")}</h2>
            <p className="text-muted-foreground text-xs leading-snug">{t("onboarding.subtitle")}</p>
          </div>
        </div>

        {/* Path A — install the local engine (self-contained install UI). */}
        <div className="grid gap-1.5">
          <span className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-wide">
            {t("onboarding.localLabel")}
          </span>
          <LocalEngineSection onInstallDone={onInstallDone} />
        </div>

        {/* Path B — use the cloud (opens Settings → Cloud payment). */}
        <div className="grid gap-1.5">
          <span className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-wide">
            {t("onboarding.cloudLabel")}
          </span>
          <button
            type="button"
            onClick={onOpenCloudSettings}
            className="border-border/60 hover:border-primary/40 hover:bg-muted/40 group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors"
          >
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
              <Cloud className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t("onboarding.cloudTitle")}</div>
              <div className="text-muted-foreground text-xs">{t("onboarding.cloudHint")}</div>
            </div>
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          </button>
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="text-muted-foreground hover:text-foreground justify-self-start text-[11px] font-medium transition-colors"
        >
          {t("onboarding.skip")}
        </button>
      </div>
    </section>
  );
}
