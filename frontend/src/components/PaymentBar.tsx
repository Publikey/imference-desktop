import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Wallet, AlertTriangle, Check, Loader2, ChevronRight } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, PaymentMode } from "@/lib/types";

type Status = { ok: boolean; label: string };

// PaymentBar — cloud-mode payment method picker. A small toggle switches between
// "API key (credit)" and "x402 (USDC wallet)"; below it, a live status for the
// active method. When it isn't usable (no key / no wallet / 0 USDC) the status
// row turns into an amber warning that deep-links to Settings → Cloud payment.
export function PaymentBar({
  settings,
  onModeChange,
  onConfigure,
}: {
  settings: AppSettings | null;
  onModeChange: (mode: PaymentMode) => void;
  onConfigure: (section: string) => void;
}) {
  const { t } = useTranslation();
  const mode: PaymentMode = settings?.paymentMode === "x402" ? "x402" : "bearer";
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);

  // `t` in the deps re-runs the check on language switch so the cached label
  // is re-rendered in the new language.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "bearer") {
        if (!settings?.apiKey) {
          setStatus({ ok: false, label: t("payment.apiKeyNotSet") });
          return;
        }
        const c = await api.getCreditBalance("");
        if (!c.configured || c.error) setStatus({ ok: false, label: c.error || t("payment.notConfigured") });
        else setStatus({ ok: c.credits > 0, label: t("payment.credits", { count: c.credits }) });
      } else {
        const w = await api.getWalletInfo();
        const bal = parseFloat(w.balanceUSDC || "0");
        if (!w.configured) setStatus({ ok: false, label: t("payment.walletNotConfigured") });
        else if (!(bal > 0)) setStatus({ ok: false, label: t("payment.fundWallet") });
        else setStatus({ ok: true, label: t("payment.usdc", { balance: w.balanceUSDC }) });
      }
    } catch {
      setStatus({ ok: false, label: t("payment.checkFailed") });
    } finally {
      setLoading(false);
    }
  }, [mode, settings?.apiKey, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const section = mode === "bearer" ? "apikey" : "x402";
  const Icon = mode === "bearer" ? KeyRound : Wallet;

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {t("payment.title")}
        </span>
        {/* Method toggle — the full form of each method still lives in Settings. */}
        <Segmented
          size="sm"
          value={mode}
          onChange={(m) => onModeChange(m as PaymentMode)}
          items={[
            { value: "bearer", label: t("payment.apiKey") },
            { value: "x402", label: "x402" },
          ]}
        />
      </div>

      <button
        type="button"
        onClick={() => onConfigure(section)}
        title={status?.ok ? t("payment.manageTitle") : t("payment.configureTitle")}
        className={cn(
          "mt-2 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition",
          status && !status.ok
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
            : "border-border/60 text-muted-foreground hover:bg-muted/40"
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        {loading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : status?.ok ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {loading ? t("common.checking") : status?.label}
        </span>
        <span className="inline-flex shrink-0 items-center gap-0.5 font-medium">
          {status && !status.ok ? t("common.configure") : t("common.manage")}
          <ChevronRight className="size-3" />
        </span>
      </button>
    </section>
  );
}
