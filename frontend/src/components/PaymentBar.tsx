import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Wallet, AlertTriangle, Loader2, ChevronRight, History } from "lucide-react";
import { onBalanceMaybeChanged, openCloudHistory } from "@/lib/target";
import { friendlyPayError } from "@/lib/pay-errors";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, PaymentMode } from "@/lib/types";

type Status = { ok: boolean; label: string };

// PaymentBar — cloud-mode payment (desktop): the live status of the active
// method ("API key (credit)" or "x402 (USDC wallet)") and a switch between
// them. When it can't pay (no key / no wallet / 0 USDC) the status turns into
// an amber warning that deep-links to Settings → Cloud payment.
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
        if (!c.configured || c.error)
          setStatus({ ok: false, label: c.error ? friendlyPayError(t, c.error) : t("payment.notConfigured") });
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
  // A purchase, a paid run, the window regaining focus: read it again.
  useEffect(() => onBalanceMaybeChanged(() => void refresh()), [refresh]);

  const section = mode === "bearer" ? "apikey" : "x402";
  const Icon = mode === "bearer" ? KeyRound : Wallet;

  return (
    <PaymentRow
      method={mode}
      methods={[
        { value: "bearer", label: t("payment.apiKey") },
        { value: "x402", label: t("payment.payg") },
      ]}
      onMethodChange={(m) => onModeChange(m as PaymentMode)}
      icon={<Icon className="size-3.5 shrink-0" />}
      ok={!status || status.ok}
      busy={loading}
      label={loading ? t("common.checking") : status?.label ?? ""}
      action={status && !status.ok ? t("common.configure") : t("common.manage")}
      title={status?.ok ? t("payment.manageTitle") : t("payment.configureTitle")}
      onClick={() => onConfigure(section)}
      onHistory={openCloudHistory}
    />
  );
}

/**
 * The payment line under the model (one card with it): the active method's
 * live status — a button to its settings — and the method switch. Turns
 * amber when the method can't pay yet.
 */
export function PaymentRow({
  method,
  methods,
  onMethodChange,
  icon,
  ok,
  busy,
  label,
  action,
  title,
  onClick,
  onHistory,
}: {
  method: string;
  methods: { value: string; label: string }[];
  onMethodChange: (m: string) => void;
  icon: ReactNode;
  ok: boolean;
  busy: boolean;
  label: string;
  action: string;
  title: string;
  onClick: () => void;
  /** The cloud calls billed to this account (CloudHistoryDialog). */
  onHistory?: () => void;
}) {
  const { t } = useTranslation();
  // Two lines: how you pay (label + method switch), then where that stands
  // (balance → its settings) and the run history.
  return (
    <div className="grid gap-2" role="group" aria-label={t("payment.title")}>
      <div className="flex items-center justify-between gap-2">
        <span className="ds-sublabel">{t("payment.title")}</span>
        <Segmented size="sm" label={t("payment.title")} value={method} onChange={onMethodChange} items={methods} />
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onClick}
          title={title}
          disabled={busy && !label}
          className={cn(
            "group -ml-2 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors",
            ok ? "text-foreground hover:bg-muted/60" : "bg-warning/10 text-warning hover:bg-warning/15 ml-0"
          )}
        >
          <span className={cn("shrink-0", ok && "text-muted-foreground")}>{icon}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          {busy ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin opacity-60" />
          ) : !ok ? (
            <AlertTriangle className="size-3.5 shrink-0" />
          ) : null}
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 font-medium",
              ok && "text-muted-foreground group-hover:text-foreground"
            )}
          >
            {action}
            <ChevronRight className="size-3.5" />
          </span>
        </button>
        {onHistory && (
          <button
            type="button"
            onClick={onHistory}
            title={t("history.title")}
            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 -mr-2 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors"
          >
            <History className="size-3.5" />
            {t("history.button")}
          </button>
        )}
      </div>
    </div>
  );
}
