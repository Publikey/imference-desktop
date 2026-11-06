import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Wallet, AlertTriangle, Loader2, ChevronRight, History, Sparkles } from "lucide-react";
import { openCloudHistory } from "@/lib/target";
import { friendlyPayError } from "@/lib/pay-errors";
import { Segmented } from "@/components/ui/segmented";
import { cn, creditsToUSD } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ApiKeyDialog } from "@/components/pay/ApiKeyDialog";
import { payProblem, type PayState } from "@/lib/pay-state";
import { PACK_CREDITS, openPayDialog } from "@/lib/web-pay";
import type { AppSettings, PaymentMode } from "@/lib/types";

// PaymentBar — cloud-mode payment (desktop), under the model. With a way to
// pay: the balance, Manage and History. Without one, or without enough for
// THIS run: a notice that says so in plain words, what the run costs, and the
// one button that fixes it — Generate is blocked until then.
export function PaymentBar({
  settings,
  pay,
  costCredits,
  onModeChange,
  onConfigure,
}: {
  settings: AppSettings | null;
  pay: PayState;
  costCredits: number;
  onModeChange: (mode: PaymentMode) => void;
  onConfigure: (section: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const mode = pay.method;
  const problem = payProblem(pay, costCredits);
  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  const usd = (credits: number) => `$${creditsToUSD(credits)}`;
  const model = settings?.cloudModelInfo?.name ?? "";

  const methods = [
    { value: "bearer", label: t("payment.apiKey") },
    { value: "x402", label: t("payment.payg") },
  ];
  // Paying per run in USDC is for people who set up the app wallet: the switch
  // only shows once there is one (or it is the method in use).
  const showSwitch = mode === "x402" || !!settings?.walletAddress;

  if (problem) {
    const credits = mode === "bearer";
    const title =
      problem === "no_method"
        ? credits ? t("payNotice.noCredits.title") : t("payNotice.noWallet.title")
        : credits ? t("payNotice.shortCredits.title") : t("payNotice.shortUsdc.title");
    const body =
      problem === "no_method"
        ? credits
          ? t("payNotice.noCredits.body", { usd: usd(PACK_CREDITS), runs: costCredits > 0 ? num(Math.floor(PACK_CREDITS / costCredits)) : "", model, count: costCredits > 0 ? Math.floor(PACK_CREDITS / costCredits) : 0 })
          : t("payNotice.noWallet.body")
        : credits
          ? t("payNotice.shortCredits.body", { cost: num(costCredits), have: num(pay.credits ?? 0) })
          : t("payNotice.shortUsdc.body", { cost: usd(costCredits), have: `$${(pay.usd ?? 0).toFixed(2)}` });
    const action =
      problem === "no_method"
        ? credits ? t("payNotice.noCredits.action") : t("payNotice.noWallet.action")
        : credits ? t("payNotice.shortCredits.action") : t("payNotice.shortUsdc.action");
    const fix = () =>
      credits ? void openPayDialog(problem === "no_method" ? "needs_key" : "insufficient_credits") : onConfigure("wallet");
    return (
      <div className="grid gap-2.5" role="group" aria-label={t("payment.title")}>
        {/* Switchable once a wallet exists: picking a way not set up yet says how to set it up. */}
        {showSwitch && (
          <div className="flex items-center justify-between gap-2">
            <span className="ds-sublabel">{t("payment.payWith")}</span>
            <Segmented size="sm" label={t("payment.payWith")} value={mode} onChange={(m) => onModeChange(m as PaymentMode)} items={methods} />
          </div>
        )}
        <PayNotice
          title={title}
          body={body}
          action={action}
          credits={credits}
          onFix={fix}
          withKeyButton={credits && problem === "no_method"}
        />
      </div>
    );
  }

  const Icon = mode === "bearer" ? KeyRound : Wallet;
  const label = pay.loading
    ? t("common.checking")
    : pay.error
      ? friendlyPayError(t, pay.error)
      : mode === "bearer"
        ? t("payment.credits", { count: pay.credits ?? 0 })
        : t("payment.usdc", { balance: (pay.usd ?? 0).toFixed(2) });
  return (
    <PaymentRow
      method={mode}
      methods={methods}
      onMethodChange={(m) => onModeChange(m as PaymentMode)}
      icon={<Icon className="size-3.5 shrink-0" />}
      ok={!pay.error}
      busy={pay.loading}
      label={label}
      action={t("common.manage")}
      title={t("payment.manageTitle")}
      onClick={() => onConfigure(mode === "bearer" ? "credits" : "wallet")}
      onHistory={openCloudHistory}
      showSwitch={showSwitch}
      switchLabel={t("payment.payWith")}
    />
  );
}

/** Why the next run can't be paid, in plain words, and the one button that
 *  fixes it (+ a link to the other way to pay). Desktop and web. */
export function PayNotice({
  title,
  body,
  action,
  credits,
  onFix,
  withKeyButton,
}: {
  title: string;
  body: string;
  action: string;
  /** Credits (brand button, sparkles) or the wallet. */
  credits: boolean;
  onFix: () => void;
  /** Credits with no key yet: "I have an Imference key" (opens the key dialog). */
  withKeyButton?: boolean;
}) {
  const { t } = useTranslation();
  const [keyOpen, setKeyOpen] = useState(false);
  return (
    <div className="ds-callout ds-callout-warning grid gap-2 p-3" role="status">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="size-4 shrink-0" />
        {title}
      </p>
      <p className="text-foreground/80 text-xs leading-relaxed">{body}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" variant={credits ? "brand" : "default"} onClick={onFix}>
          {credits ? <Sparkles className="size-4" /> : <Wallet className="size-4" />}
          {action}
        </Button>
        {withKeyButton && (
          <Button size="sm" variant="outline" onClick={() => setKeyOpen(true)}>
            <KeyRound className="size-4" />
            {t("apiKeyDialog.button")}
          </Button>
        )}
      </div>
      {withKeyButton && <ApiKeyDialog open={keyOpen} onOpenChange={setKeyOpen} />}
    </div>
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
  showSwitch = true,
  switchLabel,
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
  /** The cloud calls billed to this key (CloudHistoryDialog). */
  onHistory?: () => void;
  /** Show the method switch (desktop: only when both ways are set up). */
  showSwitch?: boolean;
  switchLabel?: string;
}) {
  const { t } = useTranslation();
  // Two lines: how you pay (label + method switch), then where that stands
  // (balance → its settings) and the run history.
  return (
    <div className="grid gap-2" role="group" aria-label={t("payment.title")}>
      {showSwitch && (
        <div className="flex items-center justify-between gap-2">
          <span className="ds-sublabel">{switchLabel ?? t("payment.title")}</span>
          <Segmented size="sm" label={switchLabel ?? t("payment.title")} value={method} onChange={onMethodChange} items={methods} />
        </div>
      )}
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
