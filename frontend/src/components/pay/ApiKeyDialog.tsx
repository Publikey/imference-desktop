import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { friendlyPayError } from "@/lib/pay-errors";
import { notifyBalanceChanged } from "@/lib/target";
import { LOST_KEY_URL, signInWithKey } from "@/lib/web-pay";

/** "I have an Imference key": paste it. It is checked against the API
 *  before it replaces anything; then it pays (desktop) or the page reloads
 *  into its session (web). */
export function ApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
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
      onOpenChange(false);
    } catch (e) {
      setErr(friendlyPayError(t, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setErr("");
          setValue("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("apiKeyDialog.title")}</DialogTitle>
          <DialogDescription>{t("apiKeyDialog.desc")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void submit();
          }}
        >
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("settings.apiKeyPlaceholder")}
            aria-label={t("apiKeyDialog.title")}
            className="font-mono"
          />
          {err && <p className="text-destructive text-sm">{err}</p>}
          <div className="flex items-center justify-end gap-2">
            <a href={LOST_KEY_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground mr-auto text-xs underline-offset-4 hover:underline">
              {t("credits.lostKey")}
            </a>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {t("credits.useKey")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
