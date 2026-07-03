import { useCallback, useEffect, useState } from "react";
import { KeyRound, Wallet, AlertTriangle, Check, Loader2, ChevronRight } from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, PaymentMode } from "@/lib/types";

type Status = { ok: boolean; label: string };

// PaymentBar — cloud-mode payment method picker. Switch between "API key
// (credit)" and "x402 (USDC wallet)", with a live status for the active method.
// When the active method isn't usable (no key / no wallet / 0 USDC) the status
// row is a call-to-action that deep-links into the matching Settings section.
export function PaymentBar({
  settings,
  onModeChange,
  onConfigure,
}: {
  settings: AppSettings | null;
  onModeChange: (mode: PaymentMode) => void;
  onConfigure: (section: string) => void;
}) {
  const mode: PaymentMode = settings?.paymentMode === "x402" ? "x402" : "bearer";
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "bearer") {
        if (!settings?.apiKey) {
          setStatus({ ok: false, label: "API key not set" });
          return;
        }
        const c = await api.getCreditBalance("");
        if (!c.configured || c.error) setStatus({ ok: false, label: c.error || "Not configured" });
        else setStatus({ ok: c.credits > 0, label: `${c.credits} credits` });
      } else {
        const w = await api.getWalletInfo();
        const bal = parseFloat(w.balanceUSDC || "0");
        if (!w.configured) setStatus({ ok: false, label: "Wallet not configured" });
        else if (!(bal > 0)) setStatus({ ok: false, label: "0 USDC — fund your wallet" });
        else setStatus({ ok: true, label: `${w.balanceUSDC} USDC` });
      }
    } catch {
      setStatus({ ok: false, label: "Check failed" });
    } finally {
      setLoading(false);
    }
  }, [mode, settings?.apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const section = mode === "bearer" ? "apikey" : "x402";
  const Icon = mode === "bearer" ? KeyRound : Wallet;

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          Payment
        </span>
        <div className="bg-muted inline-flex items-center gap-0.5 rounded-lg p-0.5 text-xs">
          {([
            ["bearer", "API key"],
            ["x402", "x402"],
          ] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition",
                mode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onConfigure(section)}
        title={status?.ok ? "Manage in Settings" : "Configure in Settings"}
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
          {loading ? "Checking…" : status?.label}
        </span>
        <span className="inline-flex shrink-0 items-center gap-0.5 font-medium">
          {status && !status.ok ? "Configure" : "Manage"}
          <ChevronRight className="size-3" />
        </span>
      </button>
    </section>
  );
}
