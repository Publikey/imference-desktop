// Desktop uses the same store and dialog: a card purchase goes through the Go
// bindings (StartCardCheckout, AdoptAPIKey) instead of web/pay/card and
// web/login, the session is read from the settings, and per-run payment uses
// the app's own wallet (Settings > Payment), not a browser one.
//
// Paying in the web version (web_pay.go on the server). The app opens without
// a key; when a run needs one, the payment dialog (components/WebPay.tsx)
// offers three ways to pay:
//   - buy a pack of credits by card (Stripe Checkout, back to /app/?checkout=…)
//   - buy the same pack in USDC with the browser wallet (x402)
//   - pay this run only, in USDC, with the browser wallet (per-run mode)
// plus "I already have a key".
//
// The server never holds a wallet key: when it needs a signature it sends the
// EIP-712 typed data to this tab ("web:sign"), the wallet signs it, and the
// signature goes back to web/sign.
import { useSyncExternalStore } from "react";
import { api } from "@/lib/wails-bridge";
import type { AppSettings, ToolInfo } from "@/lib/types";
import { isWeb, notifyBalanceChanged, notifySettingsChanged } from "@/lib/target";
import { payErrorCode } from "@/lib/pay-errors";

const CSRF = { "X-Imference-Web": "1" };
const KEY_STORAGE = "imference_api_key"; // shared with imference.com/payments
const NEW_KEY = "imference.web.newKey"; // show "keep your key" after a reload
const CHECKOUT = "imference.web.checkout"; // balance before a Stripe redirect
const PENDING_KEY = "imference.web.pendingKey"; // a guest's new key, until its checkout is paid

export const PACK_CREDITS = 5000;
export const PACK_USD = 5;

// "choose": the first "how do you want to pay?" (the welcome tour's button) —
// the only time the web window offers pay-as-you-go next to credits.
export type PayReason = "needs_key" | "insufficient_credits" | "needs_wallet" | "manual" | "choose";

/** What the run that needs paying costs (credits; 1 credit = $0.001). */
export type PayQuote = { credits: number; label: string; image?: string; kind: "image" | "video" | "tool" } | null;

export type Session = { hasKey: boolean; keyHint: string; payMode: "" | "wallet"; payer: string };

type Dialog = { reason: PayReason; quote: PayQuote; resolve: (retry: boolean) => void };
type Signing = { usd: number; address: string; wallet: string; purpose?: "history" };
export type Notice =
  | { kind: "checkout-pending" }
  | { kind: "credits-added"; credits: number }
  | { kind: "checkout-cancelled" }
  | null;

type State = {
  session: Session;
  balance: number | null; // credits on the key; null = unknown / no key
  dialog: Dialog | null;
  signing: Signing | null;
  notice: Notice;
  newKey: string | null; // a key just created: shown once, "keep it"
  wallets: BrowserWallet[]; // wallets this browser has (EIP-6963)
  walletId: string; // the one the user picked
};

let state: State = {
  session: { hasKey: false, keyHint: "", payMode: "", payer: "" },
  balance: null,
  dialog: null,
  signing: null,
  notice: null,
  newKey: null,
  wallets: [],
  walletId: (() => {
    try {
      return localStorage.getItem("imference.web.wallet") ?? "";
    } catch {
      return "";
    }
  })(),
};
const subs = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export function useWebPay(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

// --------------------------------------------------------------- server

/** An error the server tagged with a payment code (web_pay.go). */
export class PayError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...CSRF },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PayError(j.error || `HTTP ${r.status}`, j.code || "");
  return j;
}

async function web(method: string, ...args: unknown[]): Promise<any> {
  return (await post("web/call", { methodName: "web." + method, args })).result;
}

/** Desktop: the session as the settings and the app's wallet describe it. */
async function desktopSession(): Promise<Session> {
  const s = await api.getSettings();
  let payer = "";
  if (s.paymentMode === "x402") {
    try {
      const w = await api.getWalletInfo();
      payer = w.configured ? w.address : "";
    } catch {
      /* no wallet readable: per-run mode without a payer */
    }
  }
  const key = s.apiKey ?? "";
  return { hasKey: !!key, keyHint: key.length >= 8 ? key.slice(-4) : "", payMode: s.paymentMode === "x402" ? "wallet" : "", payer };
}

export async function refreshSession(): Promise<Session> {
  const s = isWeb ? ((await web("Session")) as Session) : await desktopSession();
  set({ session: s });
  if (s.hasKey) void refreshBalance();
  else set({ balance: null });
  return s;
}

export async function refreshBalance(): Promise<number | null> {
  if (!state.session.hasKey) return null;
  try {
    const info = await api.getCreditBalance("");
    const b = info.configured && !info.error ? info.credits : null;
    set({ balance: b });
    return b;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- wallet
// Wallets are discovered with EIP-6963: each extension announces itself, so
// with MetaMask AND Coinbase Wallet installed the user picks one, instead of
// both fighting over window.ethereum (a request sent there can wait forever
// in the wallet that lost). window.ethereum is only the fallback for wallets
// that don't announce.

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<any> };

export type BrowserWallet = { id: string; name: string; icon: string; provider: Eip1193 };

const WALLET_CHOICE = "imference.web.wallet";

function walletList(): BrowserWallet[] {
  const list = [...announced.values()];
  const legacy = (window as any).ethereum as (Eip1193 & Record<string, unknown>) | undefined;
  if (!list.length && legacy) {
    const name = legacy.isCoinbaseWallet
      ? "Coinbase Wallet"
      : legacy.isRabby
        ? "Rabby"
        : legacy.isMetaMask
          ? "MetaMask"
          : "Wallet";
    list.push({ id: "window.ethereum", name, icon: "", provider: legacy });
  }
  return list;
}

const announced = new Map<string, BrowserWallet>();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: any) => {
    const d = e.detail;
    if (!d?.info?.rdns || !d?.provider) return;
    announced.set(d.info.rdns, { id: d.info.rdns, name: d.info.name, icon: d.info.icon || "", provider: d.provider });
    set({ wallets: walletList() });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Wallets answer synchronously; window.ethereum covers the ones that don't.
  set({ wallets: walletList() });
}

/** The wallet runs are paid with: the user's last choice, else the first found. */
function chosenWallet(): BrowserWallet | null {
  const list = state.wallets.length ? state.wallets : walletList();
  return list.find((w) => w.id === state.walletId) ?? list[0] ?? null;
}

export function chooseWallet(id: string) {
  try {
    localStorage.setItem(WALLET_CHOICE, id);
  } catch {
    /* the choice lasts for this page */
  }
  set({ walletId: id });
}

const BASE_CHAIN = "0x2105"; // 8453

/** Asks the chosen wallet for an account; returns its address. */
export async function connectWallet(): Promise<string> {
  const w = chosenWallet();
  if (!w) throw new Error("no_wallet");
  const accounts: string[] = await w.provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.[0]) throw new Error("no_account");
  return accounts[0];
}

async function ensureBase(eth: Eip1193) {
  if ((await eth.request({ method: "eth_chainId" })) === BASE_CHAIN) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN }] });
  } catch (e: any) {
    if (e?.code !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: BASE_CHAIN,
        chainName: "Base",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://mainnet.base.org"],
        blockExplorerUrls: ["https://basescan.org"],
      }],
    });
  }
}

/** A "web:sign" request from the server: have the wallet sign it. */
export async function handleSignRequest(req: {
  id: string;
  address: string;
  amount?: string;
  typedData?: unknown;
  /** A sign-in to read the call history: personal_sign, no payment. */
  purpose?: "history";
  message?: string;
}) {
  const reply = (body: Record<string, string>) => post("web/sign", { id: req.id, ...body }).catch(() => {});
  const w = chosenWallet();
  if (!w) return reply({ error: "no wallet in this browser" });
  const history = req.purpose === "history" && typeof req.message === "string";
  set({
    signing: {
      usd: Number(req.amount || 0) / 1e6,
      address: req.address,
      wallet: w.name,
      purpose: history ? "history" : undefined,
    },
  });
  try {
    let signature: string;
    if (history) {
      // personal_sign takes the message hex-encoded (UTF-8), then the address.
      const hex =
        "0x" + Array.from(new TextEncoder().encode(req.message), (b) => b.toString(16).padStart(2, "0")).join("");
      signature = await w.provider.request({ method: "personal_sign", params: [hex, req.address] });
    } else {
      await ensureBase(w.provider);
      signature = await w.provider.request({
        method: "eth_signTypedData_v4",
        params: [req.address, JSON.stringify(req.typedData)],
      });
    }
    await reply({ signature });
  } catch (e: any) {
    // 4001 = the user rejected the request in the wallet.
    await reply({ error: e?.code === 4001 ? "cancelled" : String(e?.message || e) });
  } finally {
    set({ signing: null });
  }
}

// --------------------------------------------------------------- paying

/** Price of the run behind a refused call, for the dialog. */
async function quote(method: string, args: any[]): Promise<PayQuote> {
  try {
    const s: AppSettings = await api.getSettings();
    const m = s.cloudModelInfo;
    const modelCredits = (fmt?: string) => {
      if (!m) return 0;
      const f = m.formats?.find((x) => x.formatCode === (fmt || m.formatCode));
      return (m.cost || 0) * (f?.creditMultiplier ?? 1);
    };
    if (method === "GenerateCloud") {
      const credits = modelCredits(args[0]?.formatCode);
      return credits > 0
        ? { credits, label: m?.name ?? "", image: m?.image || undefined, kind: m?.modelType === "video" ? "video" : "image" }
        : null;
    }
    if (method === "RunTool") {
      const tools: ToolInfo[] = await api.listTools();
      const tool = tools.find((x) => x.id === args[0]?.toolId);
      if (!tool) return null;
      const credits = tool.priceIsModel ? modelCredits() : tool.priceCredits;
      return credits > 0 ? { credits, label: tool.name, kind: "tool" } : null;
    }
  } catch {
    /* the dialog works without a price */
  }
  return null;
}

/** Opens the payment dialog; resolves true when the run should be retried. */
export function openPayDialog(reason: PayReason, q: PayQuote = null): Promise<boolean> {
  if (!isWeb) {
    void refreshSession();
  }
  return new Promise((resolve) => {
    state.dialog?.resolve(false);
    set({ dialog: { reason, quote: q, resolve } });
  });
}

export function closePayDialog(retry: boolean) {
  const d = state.dialog;
  set({ dialog: null });
  d?.resolve(retry);
}

const PAY_CODES = new Set(["needs_key", "insufficient_credits", "needs_wallet"]);

/**
 * Runs a paid call (GenerateCloud, RunTool); when the server says it can't be
 * paid, asks the user and retries once they chose how.
 */
export async function withPayment<T>(method: string, args: any[], run: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      const out = await run();
      void refreshBalance();
      return out;
    } catch (e: any) {
      if (!PAY_CODES.has(e?.code)) throw e;
      if (e.code === "insufficient_credits") await refreshBalance();
      const retry = await openPayDialog(e.code as PayReason, await quote(method, args));
      if (!retry) throw new PayError(e.message, "payment_needed");
    }
  }
}

/** Moving to another key changes the server session: reload into it. */
function reloadInto(apiKey: string, isNew: boolean) {
  try {
    localStorage.setItem(KEY_STORAGE, apiKey);
    if (isNew) sessionStorage.setItem(NEW_KEY, apiKey);
  } catch {
    /* storage blocked: the session still holds the key */
  }
  window.location.reload();
}

/** An Embedded Checkout session for one pack, and what to do once it is paid. */
export type CardCheckout = {
  clientSecret: string;
  publishableKey: string;
  apiKey: string; // the key the pack lands on (a new one for a guest)
  hadKey: boolean;
  before: number; // balance before paying
};

/** Pack choices offered in the dialog (the API caps a checkout at 100). */
export const PACK_CHOICES = [1, 2, 4, 10] as const;

/** Packs by card, step 1: the session Stripe's form is mounted with. */
export async function startCardCheckout(packs = 1): Promise<CardCheckout> {
  if (!isWeb) await refreshSession(); // the settings may have changed meanwhile
  const hadKey = state.session.hasKey;
  const before = hadKey ? (state.balance ?? 0) : 0;
  if (!isWeb) {
    const out = await api.startCardCheckout(packs);
    return { clientSecret: out.clientSecret, publishableKey: out.publishableKey, apiKey: out.apiKey, hadKey, before };
  }
  const out = await post("web/pay/card", { quantity: packs });
  // A payment method that redirects comes back to /app/?checkout=success:
  // remember what to finish then.
  try {
    sessionStorage.setItem(CHECKOUT, String(before));
    if (!hadKey) sessionStorage.setItem(PENDING_KEY, out.apiKey);
  } catch {
    /* without storage, only the in-page completion finishes it */
  }
  return { clientSecret: out.clientSecret, publishableKey: out.publishableKey, apiKey: out.apiKey, hadKey, before };
}

let stripeScript: Promise<void> | null = null;

/** Stripe.js, loaded on first use (Stripe requires js.stripe.com; "dahlia"
 *  matches the API version the server's Stripe library speaks). */
export async function loadStripe(publishableKey: string): Promise<any> {
  stripeScript ??= new Promise<void>((resolve, reject) => {
    if ((window as any).Stripe) return resolve();
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/dahlia/stripe.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      stripeScript = null;
      reject(new Error("stripe_unavailable"));
    };
    document.head.appendChild(s);
  });
  await stripeScript;
  return (window as any).Stripe(publishableKey);
}

/** Signs a guest in with the key a purchase created (the session and its tabs move to it). */
async function adoptKey(apiKey: string) {
  if (!isWeb) {
    await api.adoptAPIKey(apiKey);
    notifySettingsChanged();
    await refreshSession();
    return;
  }
  await post("web/login", { apiKey });
  try {
    localStorage.setItem(KEY_STORAGE, apiKey);
  } catch {
    /* the session holds the key */
  }
  await refreshSession();
}

/**
 * Pack by card, step 2 (Stripe's onComplete): moves a guest to the new key,
 * then waits for the webhook to credit it. Resolves with the credits added
 * (0 when they haven't landed after two minutes).
 */
export async function finishCardCheckout(c: CardCheckout): Promise<number> {
  try {
    sessionStorage.removeItem(CHECKOUT);
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clean */
  }
  if (!c.hadKey) await adoptKey(c.apiKey);
  for (let i = 0; i < 60; i++) {
    const b = await refreshBalance();
    if (b !== null && b > c.before) {
      notifyBalanceChanged();
      return b - c.before;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  notifyBalanceChanged();
  return 0;
}

/** Shows "keep your key" for a key a purchase just created. */
export function showNewKey(apiKey: string) {
  set({ newKey: apiKey });
}

// ------------------------------------------------------- packs in crypto

export type CryptoCoin = { code: string; name: string; minUsd: number };

/** A pack to pay in crypto (NOWPayments behind imference.com). */
export type CryptoPayment = {
  orderId: string;
  apiKey: string; // the key the credits land on (a new one for a guest)
  payAddress: string;
  payAmount: string;
  payCurrency: string;
  coinName: string;
  network: string;
  payinExtraId: string; // memo / tag the coin needs, "" when none
  expiresAt: string;
  credits: number;
  hadKey: boolean;
};

export type CryptoStatus = { status: string; credits: number; credited: number };

/** The coins a pack can be paid with. */
export async function cryptoCoins(): Promise<CryptoCoin[]> {
  return api.cryptoCoins();
}

/**
 * A crypto payment for `packs` packs. Unlike a card, it can complete after the
 * dialog is closed, so a guest moves to the new key right away: the credits
 * never land on a key nobody has.
 */
export async function startCryptoPayment(packs: number, coin: string): Promise<CryptoPayment> {
  if (!isWeb) await refreshSession(); // the settings may have changed meanwhile
  const hadKey = state.session.hasKey;
  const p = await api.startCryptoPayment(packs, coin);
  if (!hadKey) await adoptKey(p.apiKey);
  return { ...p, hadKey };
}

/** A crypto payment's state. */
export async function cryptoPaymentStatus(orderId: string): Promise<CryptoStatus> {
  return api.cryptoPaymentStatus(orderId);
}

/** Credits landed: refresh the balance everywhere. */
export async function finishCryptoPayment(): Promise<void> {
  await refreshBalance();
  notifyBalanceChanged();
}

/** Desktop: the payment method, saved in the settings. */
async function setDesktopMode(mode: "bearer" | "x402") {
  const s = await api.getSettings();
  await api.saveSettings({ ...s, paymentMode: mode });
  notifySettingsChanged();
  await refreshSession();
}

/** Per-run mode: every run asks the wallet to sign its own price. */
export async function payPerRun(): Promise<void> {
  if (!isWeb) {
    const w = await api.getWalletInfo();
    if (!w.configured) throw new PayError("no wallet in this app yet", "needs_wallet");
    return setDesktopMode("x402");
  }
  const address = await connectWallet();
  await web("SetPayMode", { mode: "wallet", address });
  await refreshSession();
}

/**
 * Web: forget the browser wallet. Runs stop being paid from it, the wallet
 * picked here is cleared, and the site's access to its accounts is revoked
 * where the wallet supports it (EIP-2255 wallet_revokePermissions: MetaMask,
 * Rabby…) — so the next "Pay with my wallet" asks to connect again.
 */
export async function forgetWallet(): Promise<void> {
  const w = chosenWallet();
  try {
    await w?.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch {
    /* not supported by this wallet: disconnect it from the wallet's own menu */
  }
  try {
    localStorage.removeItem(WALLET_CHOICE);
  } catch {
    /* nothing stored */
  }
  set({ walletId: "" });
  if (isWeb) await web("SetPayMode", { mode: "" });
  await refreshSession();
}

/** Back to credits (the key) after per-run mode. */
export async function switchToCredits(): Promise<void> {
  if (!isWeb) return setDesktopMode("bearer");
  await web("SetPayMode", { mode: "" });
  await refreshSession();
}

/** Signs in with a key the user pasted. Throws PayError("invalid_key"). */
export async function signInWithKey(key: string): Promise<void> {
  if (!isWeb) {
    // Checked against the API first: a mistyped key never replaces a good one.
    const info = await api.getCreditBalance(key.trim());
    if (info.error) throw new PayError(info.error, payErrorCode(info.error) === "invalid_key" ? "invalid_key" : "");
    return adoptKey(key.trim());
  }
  await post("web/login", { apiKey: key.trim() });
  reloadInto(key.trim(), false);
}

export async function signOut() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* nothing stored */
  }
  await post("web/logout", {});
  window.location.reload();
}

export function dismissNotice() {
  set({ notice: null });
}

export function dismissNewKey() {
  set({ newKey: null });
}

// ------------------------------------------------------- recovery email

/** The saved key's recovery email, masked ("j***@gmail.com"); "" when none. */
export async function getRecoveryEmail(): Promise<string> {
  return api.getRecoveryEmail();
}

/** Links the email to the key at once; imference.com emails the key to it. */
export async function addRecoveryEmail(email: string): Promise<string> {
  return api.addRecoveryEmail(email.trim());
}

export async function removeRecoveryEmail(): Promise<void> {
  await api.removeRecoveryEmail();
}

/** imference.com's "Lost your Imference key?" page. */
export const LOST_KEY_URL = "https://imference.com/key";

// --------------------------------------------------------------- startup

/** Polls the balance after a card payment until the webhook has credited it. */
async function awaitCheckoutCredits(before: number) {
  set({ notice: { kind: "checkout-pending" } });
  for (let i = 0; i < 60; i++) {
    const b = await refreshBalance();
    if (b !== null && b > before) {
      set({ notice: { kind: "credits-added", credits: b - before } });
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Still nothing after 2 minutes: the webhook is late. The balance chip
  // shows it when it lands.
  set({ notice: null });
}

/**
 * Runs before the app renders: restores the key this browser already knows
 * (imference.com stores it after a purchase), and handles the return from
 * Stripe.
 */
export async function bootstrapWebPay() {
  let s = await refreshSession().catch(() => state.session);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY_STORAGE);
  } catch {
    /* storage blocked */
  }
  if (!s.hasKey && stored) {
    try {
      await post("web/login", { apiKey: stored });
      s = await refreshSession();
    } catch (e: any) {
      if (e?.code === "invalid_key") {
        try {
          localStorage.removeItem(KEY_STORAGE);
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    const k = sessionStorage.getItem(NEW_KEY);
    if (k) {
      sessionStorage.removeItem(NEW_KEY);
      set({ newKey: k });
    }
  } catch {
    /* ignore */
  }

  const url = new URL(window.location.href);
  const checkout = url.searchParams.get("checkout");
  if (checkout) {
    url.searchParams.delete("checkout");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    let before = 0;
    try {
      before = Number(sessionStorage.getItem(CHECKOUT) || 0);
      sessionStorage.removeItem(CHECKOUT);
    } catch {
      /* ignore */
    }
    if (checkout === "success") {
      // A payment method that redirected: finish what the in-page completion would have.
      let pending: string | null = null;
      try {
        pending = sessionStorage.getItem(PENDING_KEY);
        sessionStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      if (pending && !s.hasKey) {
        await adoptKey(pending).catch(() => {});
        showNewKey(pending);
      }
      void awaitCheckoutCredits(before);
    } else set({ notice: { kind: "checkout-cancelled" } });
  }

  // The balance moves with every run and with purchases made elsewhere.
  window.addEventListener("focus", () => void refreshBalance());
}
