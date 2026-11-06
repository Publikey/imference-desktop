// Web version only: the payment dialog, the wallet-signing card, the purchase
// notices, "keep your key", and the account chip in the header. The logic
// lives in lib/web-pay.ts.
import React, { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, ArrowLeft, Bitcoin, Check, CheckCircle2, ChevronDown, ChevronRight, Clock, Coins, CreditCard, Copy, Download, KeyRound, Loader2, Lock, Mail, ShieldCheck, Sparkles, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { PayNotice, PaymentRow } from "@/components/PaymentBar";
import { openCloudHistory } from "@/lib/target";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PACK_CREDITS,
  PACK_USD,
  PACK_CHOICES,
  finishCardCheckout,
  loadStripe,
  showNewKey,
  startCardCheckout,
  type CardCheckout,
  cryptoCoins,
  cryptoPaymentStatus,
  finishCryptoPayment,
  startCryptoPayment,
  type CryptoCoin,
  type CryptoPayment,
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
  forgetWallet,
  LOST_KEY_URL,
  addRecoveryEmail,
} from "@/lib/web-pay";
import { isWeb } from "@/lib/target";

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
  const [busy, setBusy] = useState<"" | "card" | "run" | "key">("");
  const [err, setErr] = useState("");
  const [key, setKey] = useState("");
  // A wallet request can sit unseen in the extension: after a few seconds,
  // say where to find it.
  const [slow, setSlow] = useState(false);
  // Paying by card: Stripe's form replaces the options, then the credits land.
  const [card, setCard] = useState<CardCheckout | null>(null);
  const [paid, setPaid] = useState<null | "waiting" | number>(null);
  // How many packs this card payment buys (one Stripe checkout).
  const [packs, setPacks] = useState<number>(1);
  // Paying per run from a crypto wallet (web): folded under the card.
  const [altOpen, setAltOpen] = useState(false);
  // Paying the pack in crypto (NOWPayments): its pane replaces the options.
  const [crypto, setCrypto] = useState(false);

  useEffect(() => {
    setBusy("");
    setErr("");
    setKey("");
    setCard(null);
    setCrypto(false);
    setPaid(null);
    setPacks(1);
    setAltOpen(dialog?.reason === "needs_wallet" || session.payMode === "wallet");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  useEffect(() => {
    setSlow(false);
    if (busy !== "run") return;
    const id = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(id);
  }, [busy]);

  if (!dialog) return null;
  const q = dialog.quote;
  // Web: offer per-run payment only when choosing a way to pay for the first
  // time (or reconnecting the wallet) — not when buying / topping up credits.
  const showPerRun = isWeb && (dialog.reason === "choose" || dialog.reason === "needs_wallet");

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
  // The crypto payment is credited: refresh, then close like a card payment.
  const onCryptoComplete = async (p: CryptoPayment, credited: number) => {
    await finishCryptoPayment().catch(() => {});
    window.setTimeout(() => {
      closePayDialog(credited > 0 && dialog.reason !== "manual");
      if (!p.hadKey) showNewKey(p.apiKey);
    }, 2500);
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
    needs_key: t("webpay.title.buy"),
    choose: t("webpay.title.needsKey"),
    insufficient_credits: t("webpay.title.insufficient"),
    needs_wallet: t("webpay.title.wallet"),
    manual: t("webpay.title.buy"),
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
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0", card ? "sm:max-w-3xl" : "sm:max-w-lg")}>
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

        {crypto && !card && (
          <CryptoPane packs={packs} onBack={() => setCrypto(false)} onComplete={(p, credited) => void onCryptoComplete(p, credited)} />
        )}

        {!card && !crypto && (
          <div className="grid gap-4 p-6">
            {/* 1. Credits by card: the way to pay. */}
            <section className="ds-card relative grid content-start gap-4 rounded-2xl p-5">
              <div>
                <div className="text-muted-foreground text-xs font-medium">{t("webpay.pack.title")}</div>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-2xl font-semibold">{t("webpay.pack.amount", { credits: num(PACK_CREDITS * packs) })}</span>
                  <span className="text-2xl font-semibold">{usd(PACK_USD * packs)}</span>
                </div>
                {/* How much to buy: 1, 2, 4 or 10 packs, one card payment. */}
                <Segmented
                  label={t("webpay.pack.howMany")}
                  value={String(packs)}
                  onChange={(v) => setPacks(Number(v))}
                  items={PACK_CHOICES.map((n) => ({ value: String(n), label: usd(PACK_USD * n) }))}
                  className="mt-3 w-full"
                />
                {q && q.credits > 0 && (
                  <p className="text-primary mt-2 text-sm font-medium">
                    {t(`webpay.pack.runs.${kind}`, {
                      count: Math.floor((PACK_CREDITS * packs) / q.credits),
                      n: num(Math.floor((PACK_CREDITS * packs) / q.credits)),
                      what: q.label,
                    })}
                  </p>
                )}
              </div>
              <ul className="text-muted-foreground grid gap-1.5 text-sm">
                <Point>{t("webpay.pack.point1")}</Point>
                <Point>{t(isWeb ? "webpay.pack.point2" : "webpay.pack.point2Desktop")}</Point>
              </ul>
              {/* Card and crypto side by side, same size: two ways to pay the same pack. */}
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Button
                    size="lg"
                    variant="brand"
                    className="h-11"
                    onClick={act("card", async () => setCard(await startCardCheckout(packs)), false)}
                    disabled={!!busy}
                  >
                    {busy === "card" ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
                    {t("webpay.pack.card", { usd: usd(PACK_USD * packs) })}
                  </Button>
                  <p className="text-muted-foreground text-center text-xs">{t("webpay.card.hint")}</p>
                </div>
                <div className="grid gap-1.5">
                  <Button size="lg" variant="brand" className="h-11" onClick={() => setCrypto(true)} disabled={!!busy}>
                    <Bitcoin className="size-4" />
                    {t("webpay.crypto.pay", { usd: usd(PACK_USD * packs) })}
                  </Button>
                  <p className="text-muted-foreground text-center text-xs">{t("webpay.crypto.hint")}</p>
                </div>
              </div>
            </section>

            {/* 2. Per run from a crypto wallet, for people who hold USDC (web only). */}
            {showPerRun && (
              <section className="grid gap-3">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-sm"
                  onClick={() => setAltOpen((o) => !o)}
                  aria-expanded={altOpen}
                >
                  <Wallet className="size-4" />
                  {t("webpay.alt.toggle")}
                  <ChevronDown className={cn("size-4 transition-transform", altOpen && "rotate-180")} />
                </button>
                {altOpen && (
                  <div className="grid gap-4 rounded-2xl border p-5">
                    {showPerRun && (
                      <div className="grid gap-3">
                        <div>
                          <div className="text-muted-foreground text-xs font-medium">{t("webpay.perRun.title")}</div>
                          <div className="mt-1 text-xl font-semibold">{q ? usd(q.credits / 1000) : t("webpay.perRun.exact")}</div>
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
                          <Button variant="outline" onClick={act("run", payPerRun, true)} disabled={!!busy || !wallet}>
                            {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                            {t("webpay.perRun.button")}
                          </Button>
                        )}
                      </div>
                    )}
                    <WalletPicker wallets={wallets} chosen={chosen} disabled={!!busy} />
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {slow && !err && (
          <div className="bg-muted mx-6 mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-sm">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
            <span>{t("webpay.wallet.waiting", { name: wallet })}</span>
          </div>
        )}

        {err && (
          <div className="ds-callout ds-callout-danger mx-6 mb-4 flex items-start gap-2 px-3 py-2 text-sm">
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
            <a className="text-muted-foreground w-full text-xs underline hover:text-foreground" href={LOST_KEY_URL} target="_blank" rel="noopener noreferrer">
              {t("credits.lostKey")}
            </a>
          </form>
        )}

        {/* Trust: who handles what. */}
        <div className="text-muted-foreground grid gap-1.5 border-t px-6 py-4 text-xs">
          <p className="flex items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("webpay.trust.card")}</span>
          </p>
          {isWeb && altOpen && (
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("webpay.trust.wallet")}</span>
            </p>
          )}
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
    <span className="size-1.5 rounded-full bg-success" />
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
            <CheckCircle2 className="size-10 text-success" />
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
        <div className="ds-callout ds-callout-danger flex items-start gap-2 px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{failed}</span>
        </div>
      )}
    </div>
  );
}

/** The pack paid in crypto: pick a coin, then send the exact amount to the address. */
function CryptoPane({
  packs,
  onBack,
  onComplete,
}: {
  packs: number;
  onBack: () => void;
  onComplete: (p: CryptoPayment, credited: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const usd = useUsd();
  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  const [coins, setCoins] = useState<CryptoCoin[] | null>(null);
  const [coin, setCoin] = useState("");
  const [p, setP] = useState<CryptoPayment | null>(null);
  const [status, setStatus] = useState("waiting");
  const [credited, setCredited] = useState(0);
  const [phase, setPhase] = useState<"coins" | "starting" | "pay" | "done" | "expired" | "failed">("coins");
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState("");
  const done = useRef(onComplete);
  done.current = onComplete;

  useEffect(() => {
    let dead = false;
    cryptoCoins()
      .then((list) => {
        if (dead) return;
        setCoins(list);
        setCoin((c) => c || list[0]?.code || "");
      })
      .catch((e) => !dead && setErr(e?.message || String(e)));
    return () => {
      dead = true;
    };
  }, []);

  // Follow the payment: every 5 s until credited, expired or failed.
  useEffect(() => {
    if (!p || phase !== "pay") return;
    let dead = false;
    let timer = 0;
    const poll = async () => {
      try {
        const st = await cryptoPaymentStatus(p.orderId);
        if (dead) return;
        setStatus(st.status);
        if (st.status === "finished" || (st.status === "partially_paid" && st.credited > 0)) {
          setCredited(st.credited);
          setPhase("done");
          done.current(p, st.credited);
          return;
        }
        if (st.status === "expired") return setPhase("expired");
        if (st.status === "failed" || st.status === "refunded") return setPhase("failed");
      } catch {
        /* network hiccup: try again */
      }
      if (!dead) timer = window.setTimeout(poll, 5000);
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      dead = true;
      window.clearTimeout(timer);
    };
  }, [p, phase]);

  useEffect(() => {
    if (phase !== "pay") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const qr = useMemo(() => {
    if (!p) return "";
    const q = qrcode(0, "M");
    q.addData(p.payAddress);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [p]);

  const start = async () => {
    setErr("");
    setPhase("starting");
    try {
      const out = await startCryptoPayment(packs, coin);
      setP(out);
      setStatus("waiting");
      setPhase("pay");
    } catch (e: any) {
      setErr(e?.message || String(e));
      setPhase("coins");
    }
  };
  const copy = (what: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(""), 1500);
    });
  };
  // The coin people know (USDT, USDC), not the code with its network.
  const ticker = (code: string) => (code.startsWith("usdt") ? "USDT" : code.startsWith("usdc") ? "USDC" : code.toUpperCase());
  const left = p?.expiresAt ? Math.max(0, Date.parse(p.expiresAt) - now) : 0;
  const mmss = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <div className="grid gap-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack} disabled={phase === "starting" || phase === "done"}>
          <ArrowLeft className="size-4" />
          {t("webpay.card.back")}
        </Button>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Lock className="size-3.5" />
          {t("webpay.crypto.secure")}
        </span>
      </div>

      {(phase === "coins" || phase === "starting") && (
        <section className="ds-card grid gap-4 rounded-2xl p-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xl font-semibold">{t("webpay.pack.amount", { credits: num(PACK_CREDITS * packs) })}</span>
            <span className="text-xl font-semibold">{usd(PACK_USD * packs)}</span>
          </div>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">{t("webpay.crypto.coin")}</span>
            <select
              className="border-input bg-background h-10 w-full rounded-lg border px-3 text-sm"
              value={coin}
              onChange={(e) => setCoin(e.target.value)}
              disabled={!coins || phase === "starting"}
            >
              {!coins && <option>{t("common.loading")}</option>}
              {coins?.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-muted-foreground text-xs">{t("webpay.crypto.fees")}</p>
          <Button size="lg" variant="brand" className="h-11" onClick={() => void start()} disabled={!coin || phase === "starting"}>
            {phase === "starting" ? <Loader2 className="size-4 animate-spin" /> : <Bitcoin className="size-4" />}
            {t("webpay.crypto.getAddress")}
          </Button>
        </section>
      )}

      {phase === "pay" && p && (
        <section className="grid gap-4">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <div
              className="size-40 shrink-0 rounded-xl bg-white p-2 [&_svg]:block [&_svg]:size-full"
              role="img"
              aria-label={t("webpay.crypto.qr")}
              dangerouslySetInnerHTML={{ __html: qr }}
            />
            <div className="grid w-full min-w-0 gap-3">
              <div>
                <div className="text-muted-foreground text-xs">{t("webpay.crypto.sendExactly")}</div>
                <div className="text-2xl font-semibold tabular-nums">
                  {p.payAmount} <span className="text-muted-foreground">{ticker(p.payCurrency)}</span>
                </div>
                <div className="text-muted-foreground text-xs">
                  {p.coinName}
                  {p.network ? ` · ${t("webpay.crypto.network", { network: p.network.toUpperCase() })}` : ""}
                </div>
              </div>
              <div className="grid gap-1">
                <span className="text-sm font-medium">{t("webpay.crypto.toAddress")}</span>
                <div className="flex gap-2">
                  <Input readOnly value={p.payAddress} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" size="icon" onClick={() => copy("address", p.payAddress)} aria-label={t("common.copy")}>
                    {copied === "address" ? <Check className="text-success size-4" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>
              {p.payinExtraId && (
                <div className="grid gap-1">
                  <span className="text-warning text-sm font-medium">{t("webpay.crypto.memo")}</span>
                  <div className="flex gap-2">
                    <Input readOnly value={p.payinExtraId} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                    <Button variant="outline" size="icon" onClick={() => copy("memo", p.payinExtraId)} aria-label={t("common.copy")}>
                      {copied === "memo" ? <Check className="text-success size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </div>
                  <span className="text-muted-foreground text-xs">{t("webpay.crypto.memoHint")}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border px-4 py-3 text-sm">
            <Loader2 className="text-primary size-4 shrink-0 animate-spin" />
            <span className="flex-1">{t(status === "waiting" ? "webpay.crypto.waiting" : "webpay.crypto.confirming")}</span>
            {status === "waiting" && left > 0 && (
              <span className="text-muted-foreground flex items-center gap-1 tabular-nums">
                <Clock className="size-3.5" />
                {mmss}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{t("webpay.crypto.keepOpen")}</p>
        </section>
      )}

      {phase === "done" && (
        <div className="grid place-items-center gap-3 py-12 text-center">
          <CheckCircle2 className="size-10 text-success" />
          <p className="font-medium">
            {status === "partially_paid"
              ? t("webpay.crypto.partial", { credits: num(credited) })
              : t("webpay.notice.added", { credits: num(credited) })}
          </p>
        </div>
      )}

      {phase === "expired" && (
        <div className="grid place-items-center gap-3 py-10 text-center">
          <p className="font-medium">{t("webpay.crypto.expired")}</p>
          <p className="text-muted-foreground text-sm">{t("webpay.crypto.expiredHint")}</p>
          <Button onClick={() => { setP(null); setPhase("coins"); }}>{t("webpay.crypto.newAddress")}</Button>
        </div>
      )}

      {phase === "failed" && p && (
        <div className="ds-callout ds-callout-danger flex items-start gap-2 px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{t("webpay.crypto.failed", { order: p.orderId })}</span>
        </div>
      )}

      {err && (
        <div className="ds-callout ds-callout-danger flex items-start gap-2 px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{err}</span>
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
        <span className="text-sm font-medium">
          {signing.purpose === "history"
            ? t("webpay.signHistoryTitle")
            : t("webpay.signTitle", { usd: usd(signing.usd) })}
        </span>
        <span className="text-muted-foreground text-xs">
          {signing.purpose === "history"
            ? t("webpay.signHistoryHint", { address: shortAddr(signing.address), name: signing.wallet })
            : t("webpay.signHint", { address: shortAddr(signing.address), name: signing.wallet })}
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
      ? "bg-[color-mix(in_oklch,var(--im-success)_16%,var(--im-canvas))] border-success/30 text-foreground"
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
    const blob = new Blob(
      [`Imference key (it holds your credits)\n${newKey}\n\nhttps://imference.com/app\nLost it one day? ${LOST_KEY_URL}\n`],
      { type: "text/plain" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "imference-key.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && dismissNewKey()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("webpay.keep.title")}</DialogTitle>
          <DialogDescription>{t(isWeb ? "webpay.keep.text" : "webpay.keep.textDesktop")}</DialogDescription>
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
          {isWeb && (
            <Button variant="outline" onClick={download}>
              <Download className="size-4" />
              {t("webpay.keep.download")}
            </Button>
          )}
        </div>
        <ProtectKey />
        <div className="flex justify-end">
          <Button onClick={dismissNewKey}>
            {t("webpay.keep.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Protect it (optional)": a recovery email typed by the user after any
 * purchase, card or USDC. It is linked to the key (already saved here) at
 * once, and imference.com emails the key to it.
 */
function ProtectKey() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      await addRecoveryEmail(email);
      setMsg(t("credits.recovery.sent"));
      setEmail("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="bg-muted/40 grid gap-2 rounded-xl border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim()) void send();
      }}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Mail className="size-4 shrink-0" />
        {t("webpay.keep.protectTitle")}
      </p>
      <p className="text-muted-foreground text-xs">{t("webpay.keep.protectHint")}</p>
      {msg ? (
        <p className="flex items-start gap-2 text-sm">
          <Check className="text-success mt-0.5 size-4 shrink-0" />
          {msg}
        </p>
      ) : (
        <div className="flex gap-2">
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label={t("credits.recovery.title")}
          />
          <Button type="submit" variant="secondary" disabled={busy || !email.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
            {t("credits.recovery.send")}
          </Button>
        </div>
      )}
      {err && <p className="text-destructive text-xs">{err}</p>}
    </form>
  );
}

/** Header: what pays the next run, and the way to get credits. */
/**
 * The payment line under the model on the web, the counterpart of the Desktop PaymentBar:
 * credits or pay as you go, and the active way's status with its next step.
 */
export function WebPaymentBar({ onConfigure }: { onConfigure: (section: string) => void }) {
  const { t, i18n } = useTranslation();
  const failure = useFailure();
  const { session, balance } = useWebPay();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const paying = session.payMode === "wallet" ? "wallet" : "credits";
  // The tab shown: picking "Pay as you go" does NOT connect the wallet by
  // itself (a wallet that kept the site's permission would answer silently,
  // and a wallet just forgotten would come straight back): it shows what to
  // do, and the user connects with an explicit click.
  const [wantWallet, setWantWallet] = useState(false);
  const mode = paying === "wallet" || wantWallet ? "wallet" : "credits";
  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

  const switchTo = async (m: string) => {
    setErr("");
    if (m === "wallet") return setWantWallet(true);
    setWantWallet(false);
    if (paying === "credits") return;
    setBusy(true);
    try {
      await switchToCredits();
    } catch (e) {
      setErr(failure(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    setErr("");
    try {
      await payPerRun();
      setWantWallet(false);
    } catch (e) {
      setErr(failure(e));
    } finally {
      setBusy(false);
    }
  };

  const buy = () => void openPayDialog("manual");
  const row: { ok: boolean; icon: React.ReactNode; label: string; action: string; title: string; onClick: () => void } =
    err
      ? { ok: false, icon: <Wallet className="size-3.5 shrink-0" />, label: err, action: t("common.manage"), title: t("payment.manageTitle"), onClick: () => onConfigure(mode === "wallet" ? "wallet" : "credits") }
      : mode === "wallet"
        ? {
            ok: true,
            icon: <Wallet className="size-3.5 shrink-0" />,
            label: t("webpay.chip.wallet", { address: shortAddr(session.payer) }),
            action: t("common.manage"),
            title: t("webpay.chip.walletTitle"),
            onClick: () => onConfigure("wallet"),
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

  const methods = [
    { value: "credits", label: t("webpay.settings.credits.title") },
    { value: "wallet", label: t("webpay.settings.wallet.title") },
  ];
  // Credits by card is the way to pay: the switch to a crypto wallet only shows
  // once the wallet is in use (it is offered in the payment dialog and Settings).
  const showSwitch = mode === "wallet";
  if (mode === "wallet" && paying !== "wallet") {
    return (
      <div className="grid gap-2.5" role="group" aria-label={t("payment.title")}>
        <div className="flex items-center justify-between gap-2">
          <span className="ds-sublabel">{t("payment.payWith")}</span>
          <Segmented size="sm" label={t("payment.payWith")} value={mode} onChange={(m) => void switchTo(m)} items={methods} />
        </div>
        <PayNotice
          credits={false}
          title={t("payNotice.webNoWallet.title")}
          body={err || t("payNotice.webNoWallet.body")}
          action={busy ? t("common.checking") : t("payNotice.webNoWallet.action")}
          onFix={() => void connect()}
        />
      </div>
    );
  }

  // Credits chosen and nothing to pay with: say so plainly (like desktop).
  if (!err && mode === "credits" && (!session.hasKey || (balance !== null && balance <= 0))) {
    const none = !session.hasKey;
    return (
      <div className="grid gap-2.5" role="group" aria-label={t("payment.title")}>
        <PayNotice
          credits
          title={none ? t("payNotice.noCredits.title") : t("payNotice.shortCredits.title")}
          body={none ? t("payNotice.webNoCredits") : t("payNotice.webNoBalance")}
          action={none ? t("payNotice.noCredits.action") : t("payNotice.shortCredits.action")}
          onFix={() => void openPayDialog(none ? "needs_key" : "insufficient_credits")}
          withKeyButton={none}
        />
      </div>
    );
  }

  return (
    <PaymentRow
      method={mode}
      methods={methods}
      onMethodChange={(m) => void switchTo(m)}
      icon={row.icon}
      ok={row.ok}
      busy={busy}
      label={busy ? t("common.checking") : row.label}
      action={row.action}
      title={row.title}
      onClick={row.onClick}
      onHistory={openCloudHistory}
      showSwitch={showSwitch}
      switchLabel={t("payment.payWith")}
    />
  );
}

function shortAddr(a: string) {
  return a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Settings > Cloud payment on the web: which way runs are paid, and each way's controls. */
/** Settings > Wallet on the web: pay each run from the browser wallet. */
export function WebWalletSettings() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const failure = useFailure();
  const { session, wallets, walletId } = useWebPay();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = wallets.find((w) => w.id === walletId) ?? wallets[0];
  const active = session.payMode === "wallet";
  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4">
      <section className="ds-card grid gap-3 p-5">
        <div className="flex items-start gap-3">
          <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-xl">
            <Wallet className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="ds-label">{t("walletPane.title")}</h3>
              <span className="text-muted-foreground bg-muted rounded-full px-2 py-px text-2xs font-medium">{t("walletPane.forWho")}</span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-sm">{t("webpay.settings.wallet.desc")}</p>
          </div>
        </div>
        <p className="text-sm">
          {active && session.payer
            ? t("webpay.settings.wallet.status", { name: chosen?.name ?? "", address: shortAddr(session.payer) })
            : t("webpay.settings.wallet.none")}
        </p>
        <WalletPicker wallets={wallets} chosen={chosen} disabled={busy} />
        <div className="flex flex-wrap gap-2">
          {active ? (
            <>
              <Button size="sm" variant="outline" onClick={act(payPerRun)} disabled={busy || !chosen}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("webpay.settings.wallet.reconnect")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={async () => {
                  const ok = await confirm({
                    title: t("webpay.settings.wallet.forgetTitle"),
                    description: t("webpay.settings.wallet.forgetBody"),
                    confirmLabel: t("webpay.settings.wallet.forget"),
                    cancelLabel: t("common.cancel"),
                  });
                  if (ok) void act(forgetWallet)();
                }}
              >
                {t("webpay.settings.wallet.forget")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={act(payPerRun)} disabled={busy || !chosen}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
              {t("webpay.settings.wallet.use")}
            </Button>
          )}
        </div>
      </section>
      {err && (
        <div className="ds-callout ds-callout-danger flex items-start gap-2 px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{err}</span>
        </div>
      )}
    </div>
  );
}
