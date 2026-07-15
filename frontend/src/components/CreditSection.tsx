import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Coins, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/wails-bridge";
import type { CreditInfo } from "@/lib/types";

type Props = {
  /** The API key currently in the Settings draft. May be unsaved — Go falls
   *  back to the saved key when this is empty. */
  apiKey: string;
};

// Mirrors the imference web app's credit readout: shows the remaining balance
// for the configured Bearer key. Auto-checks on mount and (debounced) whenever
// the key changes, plus a manual refresh button.
export function CreditSection({ apiKey }: Props) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<CreditInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // Read the latest key inside check() without making it a dependency (which
  // would re-create the debounce effect on every keystroke).
  const keyRef = useRef(apiKey);
  keyRef.current = apiKey;

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await api.getCreditBalance(keyRef.current.trim());
      setInfo(fresh);
    } catch (e) {
      setInfo({ configured: true, credits: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounce so editing/pasting the key doesn't fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => void check(), 600);
    return () => window.clearTimeout(t);
  }, [apiKey, check]);

  return (
    <div className="bg-muted/30 mt-3 grid gap-1 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Coins className="text-muted-foreground size-3.5" />
        <Label className="text-muted-foreground text-xs">{t("credit.balance")}</Label>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void check()}
          disabled={loading}
          className="ml-auto size-6"
          title={t("credit.refreshTitle")}
        >
          <RefreshCw className={"size-3.5 " + (loading ? "animate-spin" : "")} />
        </Button>
      </div>

      {info && !info.configured && (
        <p className="text-muted-foreground text-xs">{t("credit.enterKey")}</p>
      )}

      {info?.configured && info.error && (
        <p className="text-destructive flex items-start gap-1.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{info.error}</span>
        </p>
      )}

      {info?.configured && !info.error && (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{info.credits}</span>
          <span className="text-muted-foreground text-xs">{t("credit.credits")}</span>
        </div>
      )}

      {!info && loading && <p className="text-muted-foreground text-xs">{t("common.checking")}</p>}
    </div>
  );
}
