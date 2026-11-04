import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/wails-bridge";
import { onBalanceMaybeChanged } from "@/lib/target";
import type { AppSettings, PaymentMode } from "@/lib/types";

// What can pay the next cloud run (desktop): the chosen method, whether it is
// set up, and its balance — read once here, shared by the payment line and
// Generate, so "can't pay" is decided the same way everywhere and BEFORE a run
// is sent (an empty wallet used to start the run and fail at signing time).

export type PayState = {
  method: PaymentMode;
  loading: boolean;
  /** A key (credits) or a wallet (USDC) exists for the chosen method. */
  configured: boolean;
  /** Credits on the key (bearer). */
  credits: number | null;
  /** USDC in the wallet, in dollars (x402). */
  usd: number | null;
  /** The balance couldn't be read (network): don't block, the server decides. */
  error: string;
};

/** Why a run can't be paid: no method set up, or not enough for this run. */
export type PayProblem = null | "no_method" | "short";

export function usePayState(settings: AppSettings | null, active: boolean): PayState & { refresh: () => void } {
  const method: PaymentMode = settings?.paymentMode === "x402" ? "x402" : "bearer";
  const apiKey = settings?.apiKey ?? "";
  const [state, setState] = useState<PayState>({ method, loading: true, configured: false, credits: null, usd: null, error: "" });

  const refresh = useCallback(async () => {
    if (!active) return;
    setState((s) => ({ ...s, method, loading: true }));
    try {
      if (method === "bearer") {
        if (!apiKey) return setState({ method, loading: false, configured: false, credits: null, usd: null, error: "" });
        const c = await api.getCreditBalance("");
        setState({ method, loading: false, configured: true, credits: c.error ? null : c.credits, usd: null, error: c.error ?? "" });
      } else {
        const w = await api.getWalletInfo();
        setState({
          method,
          loading: false,
          configured: w.configured,
          credits: null,
          usd: w.configured && !w.error ? parseFloat(w.balanceUSDC || "0") : null,
          error: w.error ?? "",
        });
      }
    } catch (e) {
      setState({ method, loading: false, configured: method === "bearer" ? !!apiKey : false, credits: null, usd: null, error: String(e) });
    }
  }, [active, method, apiKey, settings?.walletAddress]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => onBalanceMaybeChanged(() => void refresh()), [refresh]);
  return { ...state, refresh };
}

/** Can `s` pay a run of `costCredits` (1 credit = $0.001)? */
export function payProblem(s: PayState, costCredits: number): PayProblem {
  if (s.loading && !s.configured) return null; // first read in flight
  if (!s.configured) return "no_method";
  if (s.error || costCredits <= 0) return null;
  if (s.method === "bearer") return s.credits !== null && s.credits < costCredits ? "short" : null;
  return s.usd !== null && s.usd * 1000 < costCredits ? "short" : null;
}
