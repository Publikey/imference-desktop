import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocalEngineSection } from "@/components/LocalEngineSection";
import { WalletSection } from "@/components/WalletSection";
import { EngineRuntimeSection } from "@/components/EngineRuntimeSection";
import { CreditSection } from "@/components/CreditSection";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { SUPPORTED_LANGUAGES, setLanguage, storedLanguage } from "@/i18n";
import type { AppSettings, EngineRuntimeSettings, PaymentMode } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: AppSettings) => void;
  /** Section id to scroll to on open (e.g. "apikey" / "x402" deep-links). */
  initialSection?: string;
};

// Left-nav table of contents. Sub-items (indented) scroll to a subsection.
// Labels are i18n keys, resolved at render.
const NAV: { id: string; labelKey: string; sub?: boolean }[] = [
  { id: "engine", labelKey: "settings.navEngine" },
  { id: "runtime", labelKey: "settings.navRuntime" },
  { id: "runtime-image", labelKey: "settings.navImage", sub: true },
  { id: "runtime-wan", labelKey: "settings.navWan", sub: true },
  { id: "payment", labelKey: "settings.navPayment" },
  { id: "apikey", labelKey: "settings.navApiKey", sub: true },
  { id: "x402", labelKey: "settings.navWallet", sub: true },
  { id: "paths", labelKey: "settings.navPaths" },
  { id: "language", labelKey: "settings.navLanguage" },
];

export function SettingsDialog({ open, onOpenChange, onSaved, initialSection }: Props) {
  const { t } = useTranslation();
  // The persisted UI-language choice ("" = follow the OS language).
  const [langChoice, setLangChoice] = useState(storedLanguage());
  const [draft, setDraft] = useState<AppSettings>({
    apiKey: "",
    pythonPath: "",
    sdxlPath: "",
    cloudModel: "",
    outputDir: "",
    paymentMode: "bearer",
    walletAddress: "",
    engineRuntime: { image: {}, wan: {} },
  });
  const [activeNav, setActiveNav] = useState<string>("engine");
  // Timestamp of the last successful auto-save — drives the transient "Saved" toast.
  const [savedAt, setSavedAt] = useState(0);

  // App version shown in the footer ("dev" for local builds).
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void api.getVersion().then(setAppVersion).catch(() => {});
  }, []);
  // Serialized last-persisted settings — auto-save skips no-op writes and avoids
  // re-firing on its own result.
  const savedRef = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    void api.getSettings().then((s) => {
      setDraft(s);
      savedRef.current = JSON.stringify(s);
    });
    // Re-read the persisted language choice: the header toggle may have
    // changed it since this dialog last opened.
    setLangChoice(storedLanguage());
  }, [open]);

  // Auto-save: every change to the draft is persisted (debounced) — no Save
  // button. Server-side, SaveSettings only restarts a *running* engine.
  useEffect(() => {
    if (!open) return;
    if (JSON.stringify(draft) === savedRef.current) return; // unchanged vs disk
    const t = window.setTimeout(() => {
      savedRef.current = JSON.stringify(draft); // mark sent so we don't re-fire
      void api
        .saveSettings(draft)
        .then((next) => {
          onSaved(next);
          setSavedAt(Date.now());
        })
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [draft, open, onSaved]);

  // Auto-hide the "Saved" toast.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(0), 1500);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const scrollTo = useCallback((id: string) => {
    setActiveNav(id);
    document.getElementById("settings-" + id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // On open (or a deep-link change), jump to the requested section. Small delay
  // so the dialog content is mounted + laid out first.
  useEffect(() => {
    if (!open) return;
    const id = initialSection || "engine";
    const t = window.setTimeout(() => {
      setActiveNav(id);
      document.getElementById("settings-" + id)?.scrollIntoView({ block: "start" });
    }, 90);
    return () => window.clearTimeout(t);
  }, [open, initialSection]);

  // LocalEngineSection (install) mutates settings server-side directly; refetch
  // into our draft AND push up so the app stays in sync without a manual Save.
  const handleInstallDone = useCallback(() => {
    void api.getSettings().then((next) => {
      setDraft(next);
      savedRef.current = JSON.stringify(next); // already persisted server-side
      onSaved(next);
    });
  }, [onSaved]);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Don't close on an accidental outside click — only the X / Done / Esc.
        onInteractOutside={(e) => e.preventDefault()}
        className="ring-border/60 max-h-[90vh] gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-1 sm:max-w-4xl"
      >
        <div className="flex max-h-[90vh]">
          {/* Nav — VS Code-style table of contents. */}
          <nav className="bg-muted/30 w-48 shrink-0 space-y-0.5 overflow-y-auto border-r p-3">
            <p className="text-muted-foreground mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide">
              {t("settings.title")}
            </p>
            {NAV.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => scrollTo(n.id)}
                className={cn(
                  "block w-full rounded-md px-2 py-1.5 text-left text-xs transition",
                  n.sub && "pl-5",
                  activeNav === n.id
                    ? "bg-background text-foreground font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/60"
                )}
              >
                {t(n.labelKey)}
              </button>
            ))}
          </nav>

          {/* Content — the scroll container the nav links jump within. */}
          <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-5">
            <DialogHeader className="space-y-1 text-left">
              <DialogTitle className="text-lg">{t("settings.title")}</DialogTitle>
              <DialogDescription>{t("settings.desc")}</DialogDescription>
            </DialogHeader>

            <section id="settings-engine" className="scroll-mt-4">
              <LocalEngineSection onInstallDone={handleInstallDone} />
            </section>

            <section id="settings-runtime" className="scroll-mt-4">
              <EngineRuntimeSection
                value={draft.engineRuntime}
                onChange={(next: EngineRuntimeSettings) =>
                  setDraft((d) => ({ ...d, engineRuntime: next }))
                }
              />
            </section>

            <section id="settings-payment" className="bg-card scroll-mt-4 rounded-2xl border p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold">{t("settings.cloudPayment")}</h3>
              <div className="grid gap-2">
                <Label className="text-xs">{t("settings.activeMethod")}</Label>
                <div className="flex gap-4 text-sm">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="paymentMode"
                      checked={draft.paymentMode !== "x402"}
                      onChange={() => setDraft({ ...draft, paymentMode: "bearer" as PaymentMode })}
                    />
                    {t("settings.apiKeyCredit")}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="paymentMode"
                      checked={draft.paymentMode === "x402"}
                      onChange={() => setDraft({ ...draft, paymentMode: "x402" as PaymentMode })}
                    />
                    {t("settings.x402Wallet")}
                  </label>
                </div>
              </div>

              <div id="settings-apikey" className="mt-4 grid gap-2 scroll-mt-4">
                <Label htmlFor="apiKey">{t("settings.apiKeyCredit")}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder={t("settings.apiKeyPlaceholder")}
                />
                <CreditSection apiKey={draft.apiKey} />
              </div>

              <div id="settings-x402" className="mt-5 scroll-mt-4">
                <Label className="text-xs">{t("settings.x402WalletLabel")}</Label>
                <div className="mt-2">
                  <WalletSection
                    onChanged={(newAddress) =>
                      setDraft((prev) => ({ ...prev, walletAddress: newAddress }))
                    }
                  />
                </div>
              </div>
            </section>

            <section
              id="settings-paths"
              className="bg-card scroll-mt-4 grid gap-4 rounded-2xl border p-4 shadow-sm"
            >
              <h3 className="text-sm font-semibold">{t("settings.paths")}</h3>
              <p className="text-muted-foreground -mt-2 text-xs">{t("settings.pathsHint")}</p>
              <div className="grid gap-2">
                <Label htmlFor="pythonPath">
                  {t("settings.pythonPath")}{" "}
                  <span className="text-muted-foreground font-normal">
                    {t("settings.pythonPathHint")}
                  </span>
                </Label>
                <Input
                  id="pythonPath"
                  value={draft.pythonPath}
                  onChange={(e) => setDraft({ ...draft, pythonPath: e.target.value })}
                  placeholder="…/engine-venv/bin/python"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="outputDir">{t("settings.outputDir")}</Label>
                <Input
                  id="outputDir"
                  value={draft.outputDir}
                  onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })}
                  placeholder={t("settings.outputDirPlaceholder")}
                />
              </div>
            </section>

            <section
              id="settings-language"
              className="bg-card scroll-mt-4 grid gap-2 rounded-2xl border p-4 shadow-sm"
            >
              <h3 className="text-sm font-semibold">{t("settings.language")}</h3>
              <select
                value={langChoice}
                onChange={(e) => {
                  setLangChoice(e.target.value);
                  setLanguage(e.target.value);
                }}
                className="border-input bg-background h-9 w-full max-w-xs rounded-md border px-2 text-sm"
              >
                <option value="">{t("settings.languageSystem")}</option>
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">{t("settings.languageHint")}</p>
            </section>

            <div className="bg-background/80 sticky bottom-0 flex items-center justify-between gap-2 border-t py-3 backdrop-blur">
              <span className="text-muted-foreground text-xs">
                Imference Desktop {appVersion === "dev" ? t("settings.devBuild") : appVersion ? `v${appVersion}` : ""}
              </span>
              <Button onClick={() => onOpenChange(false)}>{t("common.done")}</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Transient "Saved" toast (sibling of the Dialog so `fixed` is viewport-relative). */}
    {savedAt > 0 && (
      <div className="animate-in fade-in slide-in-from-bottom-2 bg-foreground text-background pointer-events-none fixed bottom-6 right-6 z-[60] inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-lg">
        <Check className="size-3.5" /> {t("settings.saved")}
      </div>
    )}
    </>
  );
}
