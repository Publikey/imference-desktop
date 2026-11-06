import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Download, Eye, EyeOff, KeyRound, Loader2, Mail, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { creditsToUSD } from "@/lib/utils";
import { friendlyPayError } from "@/lib/pay-errors";
import { notifyBalanceChanged, onBalanceMaybeChanged } from "@/lib/target";
import {
  LOST_KEY_URL,
  addRecoveryEmail,
  getRecoveryEmail,
  openPayDialog,
  removeRecoveryEmail,
  signInWithKey,
  signOut as webSignOut,
} from "@/lib/web-pay";
import { isWeb } from "@/lib/target";
import type { AppSettings, CreditInfo } from "@/lib/types";

// Settings > Credits & key. Credits are prepaid and live on an Imference key:
// there is no account, no email and no password. The pane says so plainly —
// empty, it explains and sells the pack; with a key, it shows the balance, the
// key, and the optional recovery email that can send the key back if lost.
export function CreditsPane({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
}) {
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

/** "I already have a key": checked against the API, then it pays the runs. */
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
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-muted-foreground hover:text-foreground text-sm font-medium underline-offset-4 hover:underline"
        >
          {t("credits.haveKey")}
        </button>
        <a
          href={LOST_KEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
        >
          {t("credits.lostKey")}
        </a>
      </div>
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
          placeholder={t("settings.apiKeyPlaceholder")}
          className="font-mono"
        />
        <Button type="submit" variant="secondary" disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {t("credits.useKey")}
        </Button>
      </div>
      {err && <p className="text-destructive text-xs">{err}</p>}
      <a href={LOST_KEY_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground justify-self-start text-xs underline-offset-4 hover:underline">
        {t("credits.lostKey")}
      </a>
      {asReplace && (
        <button type="button" onClick={onDone} className="text-muted-foreground hover:text-foreground justify-self-start text-xs">
          {t("common.cancel")}
        </button>
      )}
    </form>
  );
}

/** A key is set: the balance, the key, its recovery email. */
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
      const blob = new Blob(
        [`Imference key (it holds your credits)\n${apiKey}\n\nhttps://imference.com/app\nLost it one day? ${LOST_KEY_URL}\n`],
        { type: "text/plain" },
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "imference-key.txt";
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

      {/* The key: it holds the credits */}
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

      <RecoveryEmail apiKey={apiKey} />

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

/**
 * The optional recovery email: linked at once, and imference.com emails the
 * key to it; imference.com/key sends it back there if it is ever lost.
 */
function RecoveryEmail({ apiKey }: { apiKey: string }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [current, setCurrent] = useState<string | null>(null); // masked; "" = none; null = loading
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      setCurrent(await getRecoveryEmail());
    } catch (e) {
      setCurrent("");
      setErr(friendlyPayError(t, e instanceof Error ? e.message : String(e)));
    }
  }, [t]);
  useEffect(() => {
    setCurrent(null);
    setAdding(false);
    setMsg("");
    void load();
  }, [apiKey, load]);
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      await addRecoveryEmail(email);
      setMsg(t("credits.recovery.sent"));
      setAdding(false);
      setEmail("");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: t("credits.recovery.removeTitle"),
      description: t("credits.recovery.removeBody"),
      confirmLabel: t("credits.recovery.remove"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setErr("");
    try {
      await removeRecoveryEmail();
      setMsg("");
      setCurrent("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ds-card grid gap-3 p-5">
      <div className="flex items-start gap-3">
        <span className="bg-muted text-foreground grid size-9 shrink-0 place-items-center rounded-xl">
          <Mail className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="ds-label">{t("credits.recovery.title")}</h3>
            <span className="text-muted-foreground bg-muted rounded-full px-2 py-px text-2xs font-medium">{t("credits.recovery.optional")}</span>
          </div>
          <p className="text-muted-foreground mt-0.5 text-sm">{t("credits.recovery.lead")}</p>
        </div>
      </div>
      {current === null ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("common.checking")}
        </p>
      ) : current ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2 text-sm">
            <Check className="text-success size-4" />
            {t("credits.recovery.linked", { email: current })}
          </span>
          <button type="button" onClick={() => void remove()} disabled={busy} className="text-muted-foreground hover:text-destructive text-sm font-medium">
            {t("credits.recovery.remove")}
          </button>
        </div>
      ) : adding ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void add();
          }}
        >
          <div className="flex gap-2">
            <Input
              type="email"
              autoComplete="email"
              autoFocus
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
          <p className="text-muted-foreground text-xs">{t("credits.recovery.privacy")}</p>
          <button type="button" onClick={() => setAdding(false)} className="text-muted-foreground hover:text-foreground justify-self-start text-xs">
            {t("common.cancel")}
          </button>
        </form>
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Mail className="size-4" />
            {t("credits.recovery.add")}
          </Button>
        </div>
      )}
      {msg && <p className="text-sm">{msg}</p>}
      {err && <p className="text-destructive text-xs">{err}</p>}
    </section>
  );
}
