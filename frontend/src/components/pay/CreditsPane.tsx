import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Download, Eye, EyeOff, KeyRound, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { creditsToUSD } from "@/lib/utils";
import { friendlyPayError } from "@/lib/pay-errors";
import { notifyBalanceChanged, onBalanceMaybeChanged } from "@/lib/target";
import { openPayDialog, signInWithKey, signOut as webSignOut } from "@/lib/web-pay";
import { isWeb } from "@/lib/target";
import type { AppSettings, CreditInfo } from "@/lib/types";

// Settings > Credits & account (desktop). Credits are prepaid and live on an
// Imference account; the account has no email or password: it IS a key. The
// pane says so plainly — empty, it explains and sells the pack; with a key, it
// shows the balance and treats the key as what it is, the account.
export function CreditsPane({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
}) {
  const { t } = useTranslation();
  const key = (draft.apiKey ?? "").trim();
  return key ? <Account apiKey={key} draft={draft} setDraft={setDraft} /> : <NoAccount />;
}

/** No key yet: what credits are, the pack, or a key from before. */
function NoAccount() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4">
      <section className="ds-card grid gap-4 p-5">
        <div className="flex items-start gap-3">
          <span className="brand-surface grid size-9 shrink-0 place-items-center rounded-xl text-white">
            <Sparkles className="size-4" />
          </span>
          <div>
            <h3 className="font-display text-base font-semibold">{t("credits.empty.title")}</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">{t("credits.empty.lead")}</p>
          </div>
        </div>
        <ul className="grid gap-2 text-sm">
          {(["point1", "point2", "point3"] as const).map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Check className="text-success mt-0.5 size-4 shrink-0" />
              <span>{t(`credits.empty.${k}`)}</span>
            </li>
          ))}
        </ul>
        <div>
          <Button variant="brand" size="lg" className="h-11" onClick={() => void openPayDialog("manual")}>
            <Sparkles className="size-4" />
            {t("credits.buy")}
          </Button>
        </div>
      </section>
      <HaveKey />
    </div>
  );
}

/** "I already have a key": checked against the API, then it becomes the account. */
function HaveKey({ asReplace = false, onDone }: { asReplace?: boolean; onDone?: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(asReplace);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await signInWithKey(value);
      notifyBalanceChanged();
      setValue("");
      onDone?.();
    } catch (e) {
      setErr(friendlyPayError(t, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground justify-self-start text-sm font-medium underline-offset-4 hover:underline"
      >
        {t("credits.haveKey")}
      </button>
    );
  return (
    <form
      className="ds-card grid gap-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) void submit();
      }}
    >
      <label htmlFor="credits-key" className="ds-label">
        {asReplace ? t("credits.useAnother") : t("credits.haveKey")}
      </label>
      <p className="text-muted-foreground text-xs">{t("credits.haveKeyHint")}</p>
      <div className="flex gap-2">
        <Input
          id="credits-key"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="im_…"
          className="font-mono"
        />
        <Button type="submit" variant="secondary" disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {t("credits.useKey")}
        </Button>
      </div>
      {err && <p className="text-destructive text-xs">{err}</p>}
      {asReplace && (
        <button type="button" onClick={onDone} className="text-muted-foreground hover:text-foreground justify-self-start text-xs">
          {t("common.cancel")}
        </button>
      )}
    </form>
  );
}

/** A key is set: the balance, then the key as the account it is. */
function Account({ apiKey, draft, setDraft }: { apiKey: string; draft: AppSettings; setDraft: (next: AppSettings) => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const [info, setInfo] = useState<CreditInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api.getCreditBalance(apiKey));
    } catch (e) {
      setInfo({ configured: true, credits: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [apiKey]);
  useEffect(() => void check(), [check]);
  useEffect(() => onBalanceMaybeChanged(() => void check()), [check]);

  const num = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  const model = draft.cloudModelInfo;
  const perRun = model?.cost ?? 0;
  const credits = info && !info.error ? info.credits : null;
  const masked = `${apiKey.slice(0, 3)}${"•".repeat(12)}${apiKey.slice(-4)}`;

  const signOut = async () => {
    const ok = await confirm({
      title: t("credits.signOut.title"),
      description: t("credits.signOut.body"),
      confirmLabel: t("credits.signOut.confirm"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    if (isWeb) void webSignOut(); // the key lives in the browser session
    else setDraft({ ...draft, apiKey: "" });
  };
  const saveFile = async () => {
    if (isWeb) {
      const blob = new Blob([`Imference API key (your account: it holds your credits)\n${apiKey}\n\nhttps://imference.com\n`], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "imference-api-key.txt";
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    try {
      const path = await api.saveAPIKeyFile();
      if (path) toast.success(t("credits.key.saved", { path }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="grid gap-4">
      {/* Balance */}
      <section className="ds-card grid gap-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="ds-label">{t("credits.balance")}</h3>
          <Button size="icon" variant="ghost" onClick={() => void check()} disabled={loading} title={t("common.refresh")} aria-label={t("common.refresh")} className="size-8">
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          </Button>
        </div>
        {info?.error ? (
          <p className="text-destructive text-sm">{friendlyPayError(t, info.error)}</p>
        ) : (
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-3xl font-semibold tabular-nums">{credits === null ? "…" : num(credits)}</span>
              <span className="text-muted-foreground text-sm">{t("credits.unit")}</span>
              {credits !== null && <span className="text-muted-foreground text-sm">· ≈ ${creditsToUSD(credits)}</span>}
            </div>
            {credits !== null && perRun > 0 && model && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t("credits.runsLeft", { count: Math.floor(credits / perRun), n: num(Math.floor(credits / perRun)), model: model.name })}
              </p>
            )}
          </div>
        )}
        <div>
          <Button variant="brand" onClick={() => void openPayDialog("manual")}>
            <Sparkles className="size-4" />
            {t("credits.buy")}
          </Button>
        </div>
      </section>

      {/* The key = the account */}
      <section className="ds-card grid gap-3 p-5">
        <div className="flex items-start gap-3">
          <span className="bg-muted text-foreground grid size-9 shrink-0 place-items-center rounded-xl">
            <KeyRound className="size-4" />
          </span>
          <div>
            <h3 className="ds-label">{t("credits.key.title")}</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">{t("credits.key.lead")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="bg-sunken min-w-0 flex-1 truncate rounded-lg border px-3 py-2 font-mono text-xs" title={shown ? apiKey : undefined}>
            {shown ? apiKey : masked}
          </code>
          <Button size="icon" variant="ghost" onClick={() => setShown((s) => !s)} title={shown ? t("common.hide") : t("common.show")} aria-label={shown ? t("common.hide") : t("common.show")}>
            {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(apiKey).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })}
            title={t("common.copy")}
            aria-label={t("common.copy")}
          >
            {copied ? <Check className="text-success size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void saveFile()}>
            <Download className="size-4" />
            {t("credits.key.saveFile")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("credits.key.where")}</p>
      </section>

      {/* Other actions */}
      {replacing ? (
        <HaveKey asReplace onDone={() => setReplacing(false)} />
      ) : (
        <div className="flex flex-wrap gap-x-5 gap-y-2 px-1 text-sm">
          <button type="button" onClick={() => setReplacing(true)} className="text-muted-foreground hover:text-foreground font-medium">
            {t("credits.useAnother")}
          </button>
          <button type="button" onClick={() => void signOut()} className="text-muted-foreground hover:text-destructive font-medium">
            {t("credits.signOut.action")}
          </button>
        </div>
      )}
    </div>
  );
}
