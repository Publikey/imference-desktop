import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Cloud,
  FolderOpen,
  Languages,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import logoUrl from "@/assets/logo.svg";
import type { AppSettings, EngineRuntimeSettings, PaymentMode } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: AppSettings) => void;
  /** Section id to open on mount (e.g. "apikey" / "x402" payment-bar deep-links). */
  initialSection?: string;
};

type PaneId = "engine" | "runtime" | "cloud" | "paths" | "language";

// Top-level categories. Each is a full pane (icon + title + one-line purpose);
// only the selected pane renders, so the dialog never becomes one long scroll.
const PANES: {
  id: PaneId;
  labelKey: string;
  descKey: string;
  icon: typeof Server;
}[] = [
  { id: "engine", labelKey: "settings.navEngine", descKey: "settings.engineDesc", icon: Server },
  { id: "runtime", labelKey: "settings.navRuntime", descKey: "settings.runtimeDesc", icon: SlidersHorizontal },
  { id: "cloud", labelKey: "settings.navPayment", descKey: "settings.cloudDesc", icon: Cloud },
  { id: "paths", labelKey: "settings.navPaths", descKey: "settings.pathsDesc", icon: FolderOpen },
  { id: "language", labelKey: "settings.navLanguage", descKey: "settings.languageDesc", icon: Languages },
];

// Map a deep-link section id (from the palette / payment bar) to its pane, plus
// an optional element to scroll to once the pane is mounted.
function resolveSection(section?: string): { pane: PaneId; scrollTo?: string } {
  switch (section) {
    case "apikey":
      return { pane: "cloud", scrollTo: "settings-apikey" };
    case "x402":
      return { pane: "cloud", scrollTo: "settings-x402" };
    case "payment":
    case "cloud":
      return { pane: "cloud" };
    case "runtime":
    case "runtime-image":
    case "runtime-wan":
    case "image":
    case "wan":
      return { pane: "runtime" };
    case "paths":
      return { pane: "paths" };
    case "language":
      return { pane: "language" };
    default:
      return { pane: "engine" };
  }
}

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
  const [pane, setPane] = useState<PaneId>("engine");
  // Timestamp of the last successful auto-save — drives the transient "Saved" chip.
  const [savedAt, setSavedAt] = useState(0);

  // App version shown in the rail footer ("dev" for local builds).
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
    const timer = window.setTimeout(() => {
      savedRef.current = JSON.stringify(draft); // mark sent so we don't re-fire
      void api
        .saveSettings(draft)
        .then((next) => {
          onSaved(next);
          setSavedAt(Date.now());
        })
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, open, onSaved]);

  // Auto-hide the "Saved" chip.
  useEffect(() => {
    if (!savedAt) return;
    const timer = window.setTimeout(() => setSavedAt(0), 1800);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  // On open (or a deep-link change), select the requested pane and, for a
  // sub-section deep-link, scroll to it once the pane content is laid out.
  useEffect(() => {
    if (!open) return;
    const { pane: target, scrollTo } = resolveSection(initialSection);
    setPane(target);
    if (!scrollTo) return;
    const timer = window.setTimeout(() => {
      document.getElementById(scrollTo)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 120);
    return () => window.clearTimeout(timer);
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

  const active = PANES.find((p) => p.id === pane) ?? PANES[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Don't close on an accidental outside click — only the X / Done / Esc.
        onInteractOutside={(e) => e.preventDefault()}
        className="ring-border/60 flex h-[86vh] max-h-[720px] gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-1 sm:max-w-3xl"
      >
        {/* Rail — brand mark, category list, version. */}
        <nav className="bg-muted/30 flex w-52 shrink-0 flex-col border-r">
          <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
            <img src={logoUrl} alt="" className="size-6" />
            <DialogTitle className="text-sm font-semibold">{t("settings.title")}</DialogTitle>
          </div>
          <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {PANES.map((p) => {
              const Icon = p.icon;
              const isActive = pane === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPane(p.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    isActive
                      ? "settings-nav-active font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/60"
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", isActive ? "text-[var(--brand-from)]" : "opacity-70")} />
                  {t(p.labelKey)}
                </button>
              );
            })}
          </div>
          <div className="text-muted-foreground border-t px-4 py-2.5 text-[11px]">
            Imference Desktop{" "}
            {appVersion === "dev" ? t("settings.devBuild") : appVersion ? `v${appVersion}` : ""}
          </div>
        </nav>

        {/* Pane — persistent header, scrollable body, footer. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start justify-between gap-3 border-b px-6 py-4">
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold leading-tight">{t(active.labelKey)}</h2>
              <p className="text-muted-foreground text-xs">{t(active.descKey)}</p>
            </div>
            {/* Radix a11y requirement; visually redundant with the header above. */}
            <DialogDescription className="sr-only">{t("settings.desc")}</DialogDescription>
          </header>

          <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {pane === "engine" && <LocalEngineSection onInstallDone={handleInstallDone} />}

            {pane === "runtime" && (
              <EngineRuntimeSection
                value={draft.engineRuntime}
                onChange={(next: EngineRuntimeSettings) =>
                  setDraft((d) => ({ ...d, engineRuntime: next }))
                }
              />
            )}

            {pane === "cloud" && (
              <div className="space-y-5">
                <div className="grid gap-2">
                  <Label className="text-xs">{t("settings.activeMethod")}</Label>
                  <div className="bg-muted/60 grid grid-cols-2 gap-1 rounded-lg p-1">
                    {(
                      [
                        ["bearer", t("settings.apiKeyCredit")],
                        ["x402", t("settings.x402Wallet")],
                      ] as const
                    ).map(([m, label]) => {
                      const on = (m === "x402") === (draft.paymentMode === "x402");
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setDraft({ ...draft, paymentMode: m as PaymentMode })}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                            on
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  id="settings-apikey"
                  className={cn(
                    "bg-card scroll-mt-4 grid gap-2 rounded-2xl border p-4 shadow-sm transition-opacity",
                    draft.paymentMode === "x402" && "opacity-55"
                  )}
                >
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

                <div
                  id="settings-x402"
                  className={cn(
                    "bg-card scroll-mt-4 rounded-2xl border p-4 shadow-sm transition-opacity",
                    draft.paymentMode !== "x402" && "opacity-55"
                  )}
                >
                  <Label className="text-xs">{t("settings.x402WalletLabel")}</Label>
                  <div className="mt-2">
                    <WalletSection
                      onChanged={(newAddress) =>
                        setDraft((prev) => ({ ...prev, walletAddress: newAddress }))
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {pane === "paths" && (
              <div className="bg-card grid gap-4 rounded-2xl border p-4 shadow-sm">
                <p className="text-muted-foreground text-xs">{t("settings.pathsHint")}</p>
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
              </div>
            )}

            {pane === "language" && (
              <div className="bg-card grid gap-2 rounded-2xl border p-4 shadow-sm">
                <Label htmlFor="lang">{t("settings.language")}</Label>
                <select
                  id="lang"
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
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-2 border-t px-6 py-3">
            <span
              className={cn(
                "text-muted-foreground inline-flex items-center gap-1.5 text-xs transition-opacity duration-200",
                savedAt > 0 ? "opacity-100" : "opacity-0"
              )}
            >
              <Check className="size-3.5 text-green-600" /> {t("settings.saved")}
            </span>
            <Button onClick={() => onOpenChange(false)}>{t("common.done")}</Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
