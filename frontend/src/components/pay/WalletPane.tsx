import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import qrcode from "qrcode-generator";
import { Check, Copy, Download, KeyRound, Loader2, Plus, RefreshCw, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { notifyBalanceChanged, onBalanceMaybeChanged } from "@/lib/target";
import type { WalletInfo } from "@/lib/types";

// Settings > USDC wallet (desktop). The other way to pay: each run in USDC at
// its exact price, from a wallet this app keeps (key in the system keychain).
// Told as three steps — create, add funds, ready — then two plain cards: back
// up the wallet's key (to a file, like the account key) and replace it.

const REFRESH_MS = 30_000;

export function WalletPane({ onAddressChange }: { onAddressChange: (address: string) => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [keyCopied, setKeyCopied] = useState(false);

  const reload = useCallback(async (force = false) => {
    try {
      const w = await api.getWalletInfo();
      if (force && w.configured) {
        try {
          w.balanceUSDC = await api.refreshWalletBalance();
          w.error = "";
        } catch (e) {
          w.error = e instanceof Error ? e.message : String(e);
        }
      }
      setInfo(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    if (!info?.configured) return;
    const id = window.setInterval(() => void reload(true), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [info?.configured, reload]);
  useEffect(() => onBalanceMaybeChanged(() => void reload(true)), [reload]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError("");
    try {
      const addr = await fn();
      if (typeof addr === "string" && addr) onAddressChange(addr);
      await reload(true);
      notifyBalanceChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () => run(() => api.generateWallet());
  const doImport = () =>
    run(async () => {
      const addr = await api.importWallet(importDraft.trim());
      setImportDraft("");
      setImporting(false);
      return addr;
    });
  const replace = async (how: "create" | "import") => {
    const ok = await confirm({
      title: t("wallet.replaceTitle"),
      description: t("wallet.replaceWarning"),
      confirmLabel: how === "create" ? t("wallet.replaceGenerate") : t("wallet.replaceImport"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    if (how === "create") await create();
    else setImporting(true);
  };
  const saveKeyFile = async () => {
    setError("");
    try {
      const path = await api.saveWalletKeyFile();
      if (path) toast.success(t("walletPane.backup.saved", { path }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const copyKey = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(await api.exportWalletPrivateKey());
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!info) return <p className="text-muted-foreground text-sm">{t("wallet.loading")}</p>;
  const balance = parseFloat(info.balanceUSDC || "0");
  const funded = info.configured && balance > 0;
  const step = !info.configured ? 1 : funded ? 3 : 2;

  return (
    <div className="grid gap-4">
      {/* What this is */}
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
            <p className="text-muted-foreground mt-0.5 text-sm">{t("walletPane.lead")}</p>
          </div>
        </div>
        <Steps step={step} />
      </section>

      {error && <div className="ds-callout ds-callout-danger px-3 py-2 text-sm">{error}</div>}

      {/* Step 1: create or import */}
      {!info.configured && !importing && (
        <section className="ds-card grid gap-3 p-5">
          <h3 className="ds-label">{t("walletPane.step1")}</h3>
          <p className="text-muted-foreground text-sm">{t("walletPane.step1Hint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t("wallet.generate")}
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)} disabled={busy}>
              <KeyRound className="size-4" />
              {t("wallet.importExisting")}
            </Button>
          </div>
        </section>
      )}

      {importing && (
        <section className="ds-card grid gap-3 p-5">
          <label htmlFor="wallet-pk" className="ds-label">
            {t("walletPane.importTitle")}
          </label>
          <Textarea
            id="wallet-pk"
            value={importDraft}
            onChange={(e) => setImportDraft(e.target.value)}
            placeholder="0x…"
            className="font-mono text-xs"
            rows={3}
          />
          <p className="text-muted-foreground text-xs">{info.configured ? t("wallet.importWarning") : t("walletPane.importHint")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setImporting(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void doImport()} disabled={busy || !importDraft.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {t("common.import")}
            </Button>
          </div>
        </section>
      )}

      {/* Step 2/3: fund it, then it pays */}
      {info.configured && !importing && (
        <section className="ds-card grid gap-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="ds-label">{funded ? t("walletPane.ready") : t("walletPane.step2")}</h3>
            <Button size="icon" variant="ghost" className="size-8" onClick={() => void run(async () => {})} disabled={busy} title={t("common.refresh")} aria-label={t("common.refresh")}>
              <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-3xl font-semibold tabular-nums">${balance.toFixed(2)}</span>
            <span className="text-muted-foreground text-sm">USDC</span>
          </div>
          {info.error && <p className="text-destructive text-xs">{t("walletPane.balanceError")}</p>}
          <div className="grid min-w-0 items-start gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
            <Qr value={info.address} />
            <div className="grid min-w-0 gap-2">
              <p className="text-sm">{funded ? t("walletPane.topUpHint") : t("walletPane.fundHint")}</p>
              <AddressRow address={info.address} />
              <p className="text-muted-foreground text-xs">{t("walletPane.network")}</p>
            </div>
          </div>
        </section>
      )}

      {/* Back up the wallet's key — like the account key, a file you keep. */}
      {info.configured && (
        <section className="ds-card grid gap-3 p-5">
          <div className="flex items-start gap-3">
            <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-xl">
              <KeyRound className="size-4" />
            </span>
            <div>
              <h3 className="ds-label">{t("walletPane.backup.title")}</h3>
              <p className="text-muted-foreground mt-0.5 text-sm">{t("walletPane.backup.lead")}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void saveKeyFile()} disabled={busy}>
              <Download className="size-4" />
              {t("walletPane.backup.saveFile")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copyKey()} disabled={busy}>
              {keyCopied ? <Check className="text-success size-4" /> : <Copy className="size-4" />}
              {keyCopied ? t("walletPane.backup.copied") : t("walletPane.backup.copy")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t("walletPane.backup.warning")}</p>
        </section>
      )}

      {/* Replace the wallet */}
      {info.configured && !importing && (
        <section className="ds-card grid gap-3 p-5">
          <div>
            <h3 className="ds-label">{t("walletPane.replace.title")}</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">{t("walletPane.replace.lead")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void replace("import")} disabled={busy}>
              <KeyRound className="size-4" />
              {t("walletPane.replace.import")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void replace("create")} disabled={busy} className="hover:text-destructive hover:border-destructive/40">
              <Plus className="size-4" />
              {t("walletPane.replace.create")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t("wallet.keychainNote")}</p>
        </section>
      )}
    </div>
  );
}

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const { t } = useTranslation();
  const items = [t("walletPane.s1"), t("walletPane.s2"), t("walletPane.s3")];
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label={t("walletPane.stepsLabel")}>
      {items.map((label, i) => {
        const n = i + 1;
        const done = n < step || (n === 3 && step === 3);
        const current = n === step && !done;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full border text-2xs font-semibold",
                done ? "bg-success/15 border-success/40 text-success" : current ? "border-[var(--brand-to)] text-foreground" : "text-muted-foreground"
              )}
            >
              {done ? <Check className="size-3" /> : n}
            </span>
            <span className={current || done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
            {n < 3 && <span className="bg-border h-px w-5" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function AddressRow({ address }: { address: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="bg-sunken min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-xs break-all" title={address}>
        {address}
      </code>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("common.copy")}
        title={t("common.copy")}
        onClick={() => void navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })}
      >
        {copied ? <Check className="text-success size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

/** The address as a QR code, drawn locally (no network), dark on white so any
 *  phone wallet reads it in both themes. */
function Qr({ value }: { value: string }) {
  const { t } = useTranslation();
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [value]);
  return (
    <div
      role="img"
      aria-label={t("walletPane.qr")}
      className="size-32 shrink-0 overflow-hidden rounded-xl bg-white p-1 [&_svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
