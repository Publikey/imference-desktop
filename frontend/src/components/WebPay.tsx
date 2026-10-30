// Web version only: the payment dialog, the wallet-signing card, the purchase
// notices, "keep your key", and the account chip in the header. The logic
// lives in lib/web-pay.ts.
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronRight, Coins, CreditCard, Copy, Download, KeyRound, Loader2, Lock, ShieldCheck, Sparkles, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PACK_CREDITS,
  PACK_USD,
  finishCardCheckout,
  loadStripe,
  showNewKey,
  startCardCheckout,
  type CardCheckout,
  buyPackWithWallet,
  closePayDialog,
  dismissNewKey,
  dismissNotice,
  openPayDialog,
  payPerRun,
  signOut,
  switchToCredits,
  signInWithKey,
  useWebPay,
  chooseWallet,
  type BrowserWallet,
} from "@/lib/web-pay";

function useUsd() {
  const { i18n } = useTranslation();
  return (usd: number) =>
    new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD", maximumFractionDigits: 3 }).format(usd);
}

/** Turns a wallet / network failure into a sentence. */
function useFailure() {
  const { t } = useTranslation();
  return (e: any): string => {
    if (e?.message === "no_wallet") return t("webpay.noWallet");
    if (e?.code === 4001 || e?.code === "payment_cancelled") return t("webpay.cancelled");
    if (e?.code === "insufficient_usdc") return t("webpay.notEnoughUsdc");
    if (e?.code === "invalid_key") return t("webpay.invalidKey");
    return e?.message || String(e);
  };
}

export function WebPayLayer() {
  return (
    <>
      <PayDialog />
      <SigningCard />
      <KeepKeyDialog />
    </>
  );
}

function PayDialog() {
  const { t, i18n } = useTranslation();
  const usd = useUsd();
  const failure = useFailure();
  const { dialog, session, balance, wallets, walletId } = useWebPay();
  const [busy, setBusy] = useState<"" | "card" | "pack" | "run" | "key">("");
  const [err, setErr] = useState("");
  const [key, setKey] = useState("");
  // A wallet request can sit unseen in the extension: after a few seconds,
  // say where to find it.
  const [slow, setSlow] = useState(false);
  // Paying by card: Stripe's form replaces the options, then the credits land.
  const [card, setCard] = useState<CardCheckout | null>(null);
  const [paid, setPaid] = useState<null | "waiting" | number>(null);

  useEffect(() => {
    setBusy("");
    setErr("");
    setKey("");
    setCard(null);
    setPaid(null);
  }, [dialog]);

  useEffect(() => {
    setSlow(false);
    if (busy !== "pack" && busy !== "run") return;
    const id = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(id);
  }, [busy]);

  if (!dialog) return null;
  const q = dialog.quote;

  // Stripe's onComplete: the pack is paid. Wait for the credits, then close —
  // and retry the run that asked for them.
  const onCardComplete = async () => {
    const c = card;
    if (!c) return;
    setPaid("waiting");
    let added = 0;
    try {
      added = await finishCardCheckout(c);
    } catch (e) {
      setErr(failure(e));
    }
    setPaid(added);
    window.setTimeout(() => {
      closePayDialog(added > 0 && dialog.reason !== "manual");
      if (!c.hadKey) showNewKey(c.apiKey);
    }, 1500);
  };
  const chosen = wallets.find((w) => w.id === walletId) ?? wallets[0];
  const wallet = chosen?.name ?? "";
  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  const kind = q?.kind ?? "image";

  const act = (which: typeof busy, fn: () => Promise<void>, retry: boolean) => async () => {
    setBusy(which);
    setErr("");
    try {
      await fn();
      if (retry) closePayDialog(true);
    } catch (e) {
      setErr(failure(e));
    } finally {
      setBusy("");
    }
  };

  const title = {
    needs_key: t("webpay.title.needsKey"),
    insufficient_credits: t("webpay.title.insufficient"),
    needs_wallet: t("webpay.title.wallet"),
    manual: t("webpay.title.manual"),
  }[dialog.reason];
  const subtitle =
    dialog.reason === "insufficient_credits" && balance !== null
      ? t("webpay.subtitle.insufficient", { credits: num(balance) })
      : dialog.reason === "needs_wallet"
        ? t("webpay.subtitle.wallet")
        : dialog.reason === "manual"
          ? t("webpay.subtitle.manual")
          : t("webpay.subtitle.needsKey");

  return (
    <Dialog open onOpenChange={(open) => !open && closePayDialog(false)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        {/* Header: what is being paid for. */}
        <div className="flex items-start gap-4 border-b p-6 pr-12">
          {q?.image ? (
            <img src={q.image} alt="" className="size-14 shrink-0 rounded-xl object-cover" />
          ) : (
            <div className="bg-primary/10 text-primary grid size-14 shrink-0 place-items-center rounded-xl">
              <Sparkles className="size-6" />
            </div>
          )}
          <DialogHeader className="min-w-0 gap-1 text-left">
            <DialogTitle className="text-xl">{title}</DialogTitle>
            <DialogDescription>{subtitle}</DialogDescription>
            {q && (
              <div className="bg-muted mt-1 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-xs">
                <span className="font-medium">{q.label}</span>
                <span className="text-muted-foreground">
                  {t(`webpay.run.${kind}`)} · {t("webpay.run.price", { credits: num(q.credits), usd: usd(q.credits / 1000) })}
                </span>
              </div>
            )}
          </DialogHeader>
        </div>

        {card && <CardPane c={card} paid={paid} onBack={() => setCard(null)} onComplete={() => void onCardComplete()} />}

        {!card && (
          <div className="grid gap-4 p-6 md:grid-cols-[1.25fr_1fr]">
            {/* 1. The pack — recommended. */}
            <section className="border-primary/40 bg-primary/[0.03] relative grid content-start gap-4 rounded-2xl border-2 p-5">
              <span className="bg-primary text-primary-foreground absolute -top-3 left-5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
                {t("webpay.recommended")}
              </span>
              <div>
                <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t("webpay.pack.title")}</div>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-2xl font-semibold">{t("webpay.pack.amount", { credits: num(PACK_CREDITS) })}</span>
                  <span className="text-2xl font-semibold">{usd(PACK_USD)}</span>
                </div>
                {q && q.credits > 0 && (
                  <p className="text-primary mt-1 text-sm font-medium">
                    {t(`webpay.pack.runs.${kind}`, {
                      count: Math.floor(PACK_CREDITS / q.credits),
                      n: num(Math.floor(PACK_CREDITS / q.credits)),
                      what: q.label,
                    })}
                  </p>
                )}
              </div>
              <ul className="text-muted-foreground grid gap-1.5 text-sm">
                <Point>{t("webpay.pack.point1")}</Point>
                <Point>{t("webpay.pack.point2")}</Point>
              </ul>
              <div className="grid gap-2">
                <Button size="lg" className="h-11" onClick={act("card", async () => setCard(await startCardCheckout()), false)} disabled={!!busy}>
                  {busy === "card" ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
                  {t("webpay.pack.card", { usd: usd(PACK_USD) })}
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11"
                  onClick={act("pack", buyPackWithWallet, true)}
                  disabled={!!busy || !wallet}
                >
                  {busy === "pack" ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                  {t("webpay.pack.usdc", { usd: usd(PACK_USD) })}
                </Button>
              </div>
            </section>

            {/* 2. Per run, in USDC — no account at all. */}
            <section className="grid content-start gap-4 rounded-2xl border p-5">
              <div>
                <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t("webpay.perRun.title")}</div>
                <div className="mt-1 text-2xl font-semibold">
                  {q ? usd(q.credits / 1000) : t("webpay.perRun.exact")}
                </div>
                <p className="text-muted-foreground mt-1 text-sm">{t(`webpay.perRun.unit.${kind}`)}</p>
              </div>
              <ul className="text-muted-foreground grid gap-1.5 text-sm">
                <Point>{t("webpay.perRun.point1")}</Point>
                <Point>{t("webpay.perRun.point2")}</Point>
              </ul>
              {session.payMode === "wallet" ? (
                <div className="grid gap-2">
                  <p className="text-sm">{t("webpay.perRun.on", { address: shortAddr(session.payer) })}</p>
                  {dialog.reason === "needs_wallet" && (
                    <Button variant="outline" onClick={act("run", payPerRun, true)} disabled={!!busy || !wallet}>
                      {t("webpay.perRun.reconnect")}
                    </Button>
                  )}
                  {session.hasKey && (
                    <Button variant="ghost" onClick={act("run", switchToCredits, false)} disabled={!!busy}>
                      {t("webpay.perRun.backToCredits")}
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11"
                  onClick={act("run", payPerRun, true)}
                  disabled={!!busy || !wallet}
                >
                  {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                  {t("webpay.perRun.button")}
                </Button>
              )}
              <WalletPicker wallets={wallets} chosen={chosen} disabled={!!busy} />
            </section>
          </div>
        )}

        {slow && !err && (
          <div className="bg-muted mx-6 mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-sm">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
            <span>{t("webpay.wallet.waiting", { name: wallet })}</span>
          </div>
        )}

        {err && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive mx-6 mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        {/* 3. A key bought earlier, in the desktop app or on imference.com. */}
        {!session.hasKey && !card && (
          <form
            className="bg-muted/40 flex flex-wrap items-center gap-2 border-t px-6 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void act("key", () => signInWithKey(key), false)();
            }}
          >
            <label className="text-sm font-medium" htmlFor="webpay-key">
              {t("webpay.haveKey")}
            </label>
            <div className="flex min-w-[min(16rem,100%)] flex-1 gap-2">
              <Input
                id="webpay-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t("settings.apiKeyPlaceholder")}
              />
              <Button type="submit" variant="secondary" disabled={!!busy || !key.trim()}>
                {busy === "key" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                {t("webpay.useKey")}
              </Button>
            </div>
          </form>
        )}

        {/* Trust: who handles what. */}
        <div className="text-muted-foreground grid gap-1.5 border-t px-6 py-4 text-xs">
          <p className="flex items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("webpay.trust.card")}</span>
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("webpay.trust.wallet")}</span>
          </p>
          <p className="pl-5.5">
            {t("webpay.trust.unit")} ·{" "}
            <a className="underline hover:text-foreground" href="https://imference.com/terms" target="_blank" rel="noopener noreferrer">
              {t("webpay.trust.terms")}
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="text-primary mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

/** The wallets this browser has (pick one when there are several), or how to get one. */
function WalletPicker({ wallets, chosen, disabled }: { wallets: BrowserWallet[]; chosen?: BrowserWallet; disabled: boolean }) {
  const { t } = useTranslation();
  if (!wallets.length) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("webpay.wallet.none")}{" "}
        <a className="underline hover:text-foreground" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">
          MetaMask
        </a>{" "}
        ·{" "}
        <a className="underline hover:text-foreground" href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener noreferrer">
          Coinbase Wallet
        </a>
      </p>
    );
  }
  if (wallets.length === 1) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <WalletIcon w={wallets[0]} />
        {t("webpay.wallet.detected", { name: wallets[0].name })}
      </p>
    );
  }
  return (
    <div className="grid gap-1.5">
      <span className="text-muted-foreground text-xs">{t("webpay.wallet.pick")}</span>
      <div className="flex flex-wrap gap-1.5">
        {wallets.map((w) => (
          <button
            key={w.id}
            type="button"
            disabled={disabled}
            onClick={() => chooseWallet(w.id)}
            className={
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors " +
              (w.id === chosen?.id ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted")
            }
          >
            <WalletIcon w={w} />
            {w.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function WalletIcon({ w }: { w: BrowserWallet }) {
  return w.icon ? (
    <img src={w.icon} alt="" className="size-4 rounded" />
  ) : (
    <span className="size-1.5 rounded-full bg-emerald-500" />
  );
}

// Stripe allows one embedded checkout at a time: each mount waits for the
// previous one to be created and destroyed (React StrictMode mounts twice).
let checkoutChain: Promise<void> = Promise.resolve();

/** Stripe's Embedded Checkout inside the payment dialog, then the wait for the credits. */
function CardPane({
  c,
  paid,
  onBack,
  onComplete,
}: {
  c: CardCheckout;
  paid: null | "waiting" | number;
  onBack: () => void;
  onComplete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onComplete);
  done.current = onComplete;
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let dead = false;
    let co: any = null;
    checkoutChain = checkoutChain
      .then(async () => {
        if (dead) return;
        const stripe = await loadStripe(c.publishableKey);
        // createEmbeddedCheckoutPage is the current name; initEmbeddedCheckout the older one.
        const create = stripe.createEmbeddedCheckoutPage ?? stripe.initEmbeddedCheckout;
        co = await create.call(stripe, {
          fetchClientSecret: async () => c.clientSecret,
          onComplete: () => done.current(),
        });
        if (dead || !ref.current) {
          co.destroy();
          co = null;
          return;
        }
        co.mount(ref.current);
        setMounted(true);
      })
      .catch((e) => {
        if (!dead) setFailed(e?.message === "stripe_unavailable" ? t("webpay.card.unavailable") : String(e?.message || e));
      });
    return () => {
      dead = true;
      co?.destroy();
      co = null;
    };
  }, [c, t]);

  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

  return (
    <div className="grid gap-3 p-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack} disabled={paid !== null}>
          <ArrowLeft className="size-4" />
          {t("webpay.card.back")}
        </Button>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Lock className="size-3.5" />
          {t("webpay.card.secure")}
        </span>
      </div>
      {paid === null ? (
        <div className="relative min-h-[480px] overflow-hidden rounded-xl bg-white">
          {!mounted && !failed && (
            <div className="absolute inset-0 grid place-items-center">
              <Loader2 className="size-6 animate-spin text-slate-400" />
            </div>
          )}
          <div ref={ref} />
        </div>
      ) : (
        <div className="grid place-items-center gap-3 py-16 text-center">
          {paid === "waiting" ? (
            <Loader2 className="text-primary size-10 animate-spin" />
          ) : (
            <CheckCircle2 className="size-10 text-emerald-500" />
          )}
          <p className="font-medium">
            {paid === "waiting"
              ? t("webpay.notice.pending")
              : paid > 0
                ? t("webpay.notice.added", { credits: num(paid) })
                : t("webpay.card.late")}
          </p>
        </div>
      )}
      {failed && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{failed}</span>
        </div>
      )}
    </div>
  );
}

function SigningCard() {
  const { t } = useTranslation();
  const usd = useUsd();
  const { signing } = useWebPay();
  if (!signing) return null;
  return (
    <div className="bg-background fixed right-4 bottom-4 z-[60] flex max-w-sm items-center gap-3 rounded-xl border p-4 shadow-lg">
      <Loader2 className="text-primary size-5 shrink-0 animate-spin" />
      <div className="grid gap-0.5">
        <span className="text-sm font-medium">{t("webpay.signTitle", { usd: usd(signing.usd) })}</span>
        <span className="text-muted-foreground text-xs">
          {t("webpay.signHint", { address: shortAddr(signing.address), name: signing.wallet })}
        </span>
      </div>
    </div>
  );
}

/** Purchase feedback under the header (Stripe return, credits landed). */
export function WebPayNotice() {
  const { t } = useTranslation();
  const { notice } = useWebPay();
  if (!notice) return null;
  const text =
    notice.kind === "checkout-pending"
      ? t("webpay.notice.pending")
      : notice.kind === "credits-added"
        ? t("webpay.notice.added", { credits: notice.credits })
        : t("webpay.notice.cancelled");
  const tone =
    notice.kind === "credits-added"
      ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100"
      : "bg-muted text-foreground";
  return (
    <div className={`${tone} flex items-center justify-center gap-3 border-b px-4 py-2 text-sm`}>
      {notice.kind === "checkout-pending" && <Loader2 className="size-4 animate-spin" />}
      <span>{text}</span>
      {notice.kind !== "checkout-pending" && (
        <button onClick={dismissNotice} aria-label={t("common.close")} className="opacity-70 hover:opacity-100">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

function KeepKeyDialog() {
  const { t } = useTranslation();
  const { newKey } = useWebPay();
  const [copied, setCopied] = useState(false);
  if (!newKey) return null;
  const download = () => {
    const blob = new Blob([`Imference API key\n${newKey}\n\nhttps://imference.com\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "imference-api-key.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && dismissNewKey()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("webpay.keep.title")}</DialogTitle>
          <DialogDescription>{t("webpay.keep.text")}</DialogDescription>
        </DialogHeader>
        <Input readOnly value={newKey} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(newKey).then(() => setCopied(true));
            }}
          >
            <Copy className="size-4" />
            {copied ? t("webpay.keep.copied") : t("webpay.keep.copy")}
          </Button>
          <Button variant="outline" onClick={download}>
            <Download className="size-4" />
            {t("webpay.keep.download")}
          </Button>
          <Button className="ml-auto" onClick={dismissNewKey}>
            {t("webpay.keep.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Header: what pays the next run, and the way to get credits. */
/**
 * Engine panel > Payment on the web, the counterpart of the Desktop PaymentBar:
 * credits or pay as you go, and the active way's status with its next step.
 */
export function WebPaymentBar({ onConfigure }: { onConfigure: (section: string) => void }) {
  const { t, i18n } = useTranslation();
  const failure = useFailure();
  const { session, balance } = useWebPay();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const mode = session.payMode === "wallet" ? "wallet" : "credits";
  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

  const switchTo = async (m: string) => {
    if (m === mode) return;
    setBusy(true);
    setErr("");
    try {
      await (m === "wallet" ? payPerRun() : switchToCredits());
    } catch (e) {
      setErr(failure(e));
    } finally {
      setBusy(false);
    }
  };

  const buy = () => void openPayDialog("manual");
  const row: { ok: boolean; icon: React.ReactNode; label: string; action: string; title: string; onClick: () => void } =
    err
      ? { ok: false, icon: <Wallet className="size-3.5 shrink-0" />, label: err, action: t("common.manage"), title: t("payment.manageTitle"), onClick: () => onConfigure("cloud") }
      : mode === "wallet"
        ? {
            ok: true,
            icon: <Wallet className="size-3.5 shrink-0" />,
            label: t("webpay.chip.wallet", { address: shortAddr(session.payer) }),
            action: t("common.manage"),
            title: t("webpay.chip.walletTitle"),
            onClick: () => onConfigure("cloud"),
          }
        : session.hasKey
          ? {
              ok: balance === null || balance > 0,
              icon: <Coins className="size-3.5 shrink-0" />,
              label: balance === null ? t("webpay.chip.credits") : t("webpay.chip.balance", { credits: num(balance) }),
              action: t("credit.buy"),
              title: t("webpay.chip.buyTitle"),
              onClick: buy,
            }
          : {
              ok: false,
              icon: <Coins className="size-3.5 shrink-0" />,
              label: t("webpay.chip.none"),
              action: t("webpay.chip.getCredits"),
              title: t("webpay.chip.buyTitle"),
              onClick: buy,
            };

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {t("payment.title")}
        </span>
        <Segmented
          size="sm"
          value={mode}
          onChange={(m) => void switchTo(m)}
          items={[
            { value: "credits", label: t("webpay.settings.credits.title") },
            { value: "wallet", label: t("webpay.settings.wallet.title") },
          ]}
        />
      </div>

      <button
        type="button"
        onClick={row.onClick}
        title={row.title}
        disabled={busy}
        className={cn(
          "mt-2 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition",
          !row.ok
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
            : "border-border/60 text-muted-foreground hover:bg-muted/40"
        )}
      >
        {row.icon}
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : row.ok ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{busy ? t("common.checking") : row.label}</span>
        <span className="inline-flex shrink-0 items-center gap-0.5 font-medium">
          {row.action}
          <ChevronRight className="size-3" />
        </span>
      </button>
    </section>
  );
}

function shortAddr(a: string) {
  return a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Settings > Cloud payment on the web: which way runs are paid, and each way's controls. */
export function WebPaymentSettings() {
  const { t, i18n } = useTranslation();
  const failure = useFailure();
  const { session, balance, wallets, walletId } = useWebPay();
  const [busy, setBusy] = useState<"" | "credits" | "wallet" | "key">("");
  const [err, setErr] = useState("");
  const [editKey, setEditKey] = useState(false);
  const [key, setKey] = useState("");

  const chosen = wallets.find((w) => w.id === walletId) ?? wallets[0];
  const walletActive = session.payMode === "wallet";
  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

  const act = (which: typeof busy, fn: () => Promise<void>) => async () => {
    setBusy(which);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(failure(e));
    } finally {
      setBusy("");
    }
  };

  const keyForm = (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) void act("key", () => signInWithKey(key))(); // reloads into the key's session
      }}
    >
      <Input
        type="password"
        autoComplete="off"
        autoFocus={editKey}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={t("settings.apiKeyPlaceholder")}
      />
      <Button type="submit" size="sm" className="h-9" disabled={!!busy || !key.trim()}>
        {busy === "key" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
        {t("webpay.useKey")}
      </Button>
    </form>
  );

  return (
    <div className="grid gap-4">
      <div>
        <h3 className="text-sm font-semibold">{t("webpay.settings.title")}</h3>
        <p className="text-muted-foreground text-xs">{t("webpay.settings.desc")}</p>
      </div>

      {/* Credits on an API key. */}
      <ModeCard
        active={!walletActive}
        icon={<Coins className="size-4" />}
        title={t("webpay.settings.credits.title")}
        desc={t("webpay.settings.credits.desc")}
        status={
          session.hasKey
            ? t("webpay.settings.credits.status", {
                hint: session.keyHint,
                credits: balance === null ? "…" : num(balance),
              })
            : t("webpay.settings.credits.none")
        }
      >
        {session.hasKey ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              {walletActive && (
                <Button size="sm" onClick={act("credits", switchToCredits)} disabled={!!busy}>
                  {busy === "credits" && <Loader2 className="size-4 animate-spin" />}
                  {t("webpay.settings.credits.use")}
                </Button>
              )}
              <Button size="sm" variant={walletActive ? "outline" : "default"} onClick={() => void openPayDialog("manual")}>
                <Coins className="size-4" />
                {t("credit.buy")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditKey((v) => !v)}>
                {t("webpay.settings.credits.change")}
              </Button>
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void signOut()}>
                {t("webpay.settings.credits.forget")}
              </Button>
            </div>
            {editKey && keyForm}
          </div>
        ) : (
          <div className="grid gap-2">
            {keyForm}
            <p className="text-muted-foreground text-xs">
              {t("webpay.key.none")}{" "}
              <button type="button" className="text-primary underline" onClick={() => void openPayDialog("manual")}>
                {t("webpay.chip.getCredits")}
              </button>
            </p>
          </div>
        )}
      </ModeCard>

      {/* Pay as you go with the browser wallet. */}
      <ModeCard
        active={walletActive}
        icon={<Wallet className="size-4" />}
        title={t("webpay.settings.wallet.title")}
        desc={t("webpay.settings.wallet.desc")}
        status={
          walletActive && session.payer
            ? t("webpay.settings.wallet.status", { name: chosen?.name ?? "", address: shortAddr(session.payer) })
            : t("webpay.settings.wallet.none")
        }
      >
        <div className="grid gap-2">
          <WalletPicker wallets={wallets} chosen={chosen} disabled={!!busy} />
          <div className="flex flex-wrap gap-2">
            {walletActive ? (
              <>
                <Button size="sm" variant="outline" onClick={act("wallet", payPerRun)} disabled={!!busy || !chosen}>
                  {busy === "wallet" && <Loader2 className="size-4 animate-spin" />}
                  {t("webpay.settings.wallet.reconnect")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={act("credits", switchToCredits)}
                  disabled={!!busy}
                >
                  {t("webpay.settings.wallet.disconnect")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={act("wallet", payPerRun)} disabled={!!busy || !chosen}>
                {busy === "wallet" ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                {t("webpay.settings.wallet.use")}
              </Button>
            )}
          </div>
        </div>
      </ModeCard>

      {err && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{err}</span>
        </div>
      )}
    </div>
  );
}

function ModeCard({
  active,
  icon,
  title,
  desc,
  status,
  children,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  desc: string;
  status: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      className={
        "bg-card grid gap-3 rounded-2xl border p-4 shadow-sm " + (active ? "border-primary ring-primary/20 ring-2" : "")
      }
    >
      <div className="flex items-start gap-3">
        <div
          className={
            "grid size-8 shrink-0 place-items-center rounded-lg " +
            (active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
          }
        >
          {icon}
        </div>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{title}</span>
            {active && (
              <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[11px] font-medium">
                {t("webpay.settings.inUse")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{desc}</p>
          <p className="mt-1 text-sm">{status}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

