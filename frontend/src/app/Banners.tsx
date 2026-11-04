// Update and error banners.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { Button } from "@/components/ui/button";
import type { UpdateInfo } from "@/lib/types";
import { Browser } from "@wailsio/runtime";
import { AlertCircle, Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";

// UpdateBanner announces a newer release. Download opens the GitHub release
// page in the system browser — no in-app download while the app is unsigned.
export function UpdateBanner({ info, onDismiss }: { info: UpdateInfo; onDismiss: () => void }) {
  const { t } = useTranslation();
  const url = info.url ?? "https://github.com/Publikey/imference-desktop/releases/latest";
  return (
    <div className="animate-in fade-in slide-in-from-top-1 flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
      <Download className="size-4 shrink-0" />
      <p className="flex-1 leading-relaxed">
        {/* Split around the bolded version so both word orders (en/zh) work. */}
        {t("update.availablePrefix")} <span className="font-semibold">v{info.latestVersion}</span>
        {t("update.availableSuffix")}
        {info.currentVersion !== "dev" && (
          <span className="opacity-70">{t("update.youHave", { version: info.currentVersion })}</span>
        )}
      </p>
      <Button
        size="sm"
        className="h-7 shrink-0 rounded-lg bg-warning px-3 text-xs font-semibold text-white hover:bg-warning"
        onClick={() => void Browser.OpenURL(url)}
      >
        {t("common.download")}
      </Button>
      <button
        onClick={onDismiss}
        className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
        aria-label={t("common.dismiss")}
        title={t("update.dismissTitle")}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="border-destructive/25 bg-destructive/5 text-destructive animate-in fade-in slide-in-from-top-1 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1 leading-relaxed">{message}</p>
      <button
        onClick={onDismiss}
        className="hover:text-destructive/70 shrink-0 text-xs font-medium"
        aria-label={t("common.dismiss")}
      >
        {t("common.dismiss")}
      </button>
    </div>
  );
}
