import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Check,
  Sparkles,
  FolderOpen,
  HardDrive,
  Languages,
  Server,
  SlidersHorizontal,
  Wallet,
  Wand2,
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
import { Select } from "@/components/ui/select";
import { LocalEngineSection } from "@/components/LocalEngineSection";
import { EngineRuntimeSection } from "@/components/EngineRuntimeSection";
import { StorageSection } from "@/components/StorageSection";
import { isWeb, SETTINGS_CHANGED_EVENT } from "@/lib/target";
import { WebWalletSettings } from "@/components/WebPay";
import { WebGallerySection } from "@/components/WebGallerySection";
import { ToolsSection } from "@/components/ToolsSection";
import { AgentsPane } from "@/components/AgentsPane";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { SUPPORTED_LANGUAGES, setLanguage, storedLanguage } from "@/i18n";
import logoUrl from "@/assets/logo.svg";
import type { AppSettings, EngineRuntimeSettings, PaymentMode } from "@/lib/types";
import { CreditsPane } from "@/components/pay/CreditsPane";
import { WalletPane } from "@/components/pay/WalletPane";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: AppSettings) => void;
  /** Section id to open on mount (e.g. "apikey" / "x402" payment-bar deep-links). */
  initialSection?: string;
};

type PaneId = "engine" | "runtime" | "tools" | "agents" | "credits" | "wallet" | "paths" | "storage" | "gallery" | "language";

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
  { id: "tools", labelKey: "settings.navTools", descKey: "settings.toolsDesc", icon: Wand2 },
  // Claude & co. driving Desktop (the local API + the Imference MCP server).
  { id: "agents", labelKey: "settings.navAgents", descKey: "settings.agentsDesc", icon: Bot },
  // Paying for cloud runs: two separate stories, two panes. Which one pays a
  // run is chosen on the payment line in Create, not here.
  { id: "credits", labelKey: "settings.navCredits", descKey: "settings.creditsDesc", icon: Sparkles },
  { id: "wallet", labelKey: "settings.navWallet", descKey: "settings.walletDesc", icon: Wallet },
  { id: "paths", labelKey: "settings.navPaths", descKey: "settings.pathsDesc", icon: FolderOpen },
  { id: "storage", labelKey: "settings.navStorage", descKey: "settings.storageDesc", icon: HardDrive },
  { id: "language", labelKey: "settings.navLanguage", descKey: "settings.languageDesc", icon: Languages },
];

// The web build has no local engine, disk or wallet: only cloud panes remain,
// plus "gallery" (where the browser keeps the user's images).
const WEB_PANES: PaneId[] = ["credits", "wallet", "gallery", "language"];
const GALLERY_PANE = { id: "gallery" as PaneId, labelKey: "web.gallery.nav", descKey: "web.gallery.desc", icon: FolderOpen };
// On the web the wallet is the browser's own (no app wallet): its pane says so.
const VISIBLE_PANES = isWeb
  ? [...PANES, GALLERY_PANE]
      .filter((p) => WEB_PANES.includes(p.id))
      .sort((a, b) => WEB_PANES.indexOf(a.id) - WEB_PANES.indexOf(b.id))
      .map((p) => (p.id === "wallet" ? { ...p, labelKey: "settings.navWalletWeb", descKey: "settings.walletDescWeb" } : p))
  : PANES;

// Map a deep-link section id (from the palette / payment bar) to its pane, plus
// an optional element to scroll to once the pane is mounted.
function resolveSection(section?: string): { pane: PaneId; scrollTo?: string } {
  switch (section) {
    // "apikey" / "payment" / "cloud" are the older names of the credits pane.
    case "credits":
    case "apikey":
    case "payment":
    case "cloud":
      return { pane: "credits" };
    case "wallet":
    case "x402":
      return { pane: "wallet" };
    case "runtime":
    case "runtime-image":
    case "runtime-wan":
    case "image":
    case "wan":
      return { pane: "runtime" };
    case "paths":
      return { pane: "paths" };
    case "tools":
      return { pane: "tools" };
    case "agents":
    case "mcp":
      return { pane: "agents" };
    case "storage":
      return { pane: "storage" };
    case "language":
      return { pane: "language" };
    case "gallery":
      return { pane: "gallery" };
    default:
      return { pane: isWeb ? "credits" : "engine" };
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
    // Nothing may be saved until the real settings are in the draft: the
    // placeholder draft (empty API key…) must never reach the disk.
    savedRef.current = "";
    if (!open) return;
    void api.getSettings().then((s) => {
      setDraft(s);
      savedRef.current = JSON.stringify(s);
    });
    // Re-read the persisted language choice: the header toggle may have
    // changed it since this dialog last opened.
    setLangChoice(storedLanguage());
  }, [open]);

  // Settings changed outside this dialog (a key adopted by the payment dialog,
  // opened from here): reload the draft, or a later edit would save the old
  // values back over them.
  useEffect(() => {
    if (!open) return;
    const reload = () =>
      void api.getSettings().then((s) => {
        setDraft(s);
        savedRef.current = JSON.stringify(s);
      });
    window.addEventListener(SETTINGS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, reload);
  }, [open]);

  // Auto-save: every change to the draft is persisted (debounced) — no Save
  // button. Server-side, SaveSettings only restarts a *running* engine.
  useEffect(() => {
    if (!open) return;
    if (!savedRef.current) return; // not loaded yet
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

  const active = VISIBLE_PANES.find((p) => p.id === pane) ?? VISIBLE_PANES[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Don't close on an accidental outside click — only the X / Done / Esc.
        onInteractOutside={(e) => e.preventDefault()}
        className="ring-border/60 flex h-[88dvh] max-h-[760px] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-1 sm:max-w-[60rem] sm:flex-row"
      >
        {/* Rail — brand mark, category list, version. On a phone it becomes a
            strip of tabs above the pane (a side rail leaves the pane no room). */}
        <nav className="bg-muted/30 flex shrink-0 flex-col border-b sm:w-56 sm:border-b-0 sm:border-r">
          <div className="flex items-center gap-2.5 px-4 pb-2 pt-4 sm:pb-3">
            <img src={logoUrl} alt="" className="size-6" />
            <DialogTitle className="text-sm font-semibold">{t("settings.title")}</DialogTitle>
          </div>
          <div className="flex gap-1 overflow-x-auto px-2 pb-2 sm:flex-1 sm:flex-col sm:gap-0.5 sm:overflow-x-visible sm:overflow-y-auto">
            {VISIBLE_PANES.map((p) => {
              const Icon = p.icon;
              const isActive = pane === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPane(p.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-sm transition-colors sm:w-full",
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
          <div className="text-muted-foreground border-t px-4 py-2.5 text-2xs max-sm:hidden">
            {isWeb ? "Imference Web" : "Imference Desktop"}{" "}
            {appVersion === "dev" ? t("settings.devBuild") : appVersion ? `v${appVersion}` : ""}
          </div>
        </nav>

        {/* Pane — persistent header, scrollable body, footer. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex items-start justify-between gap-3 border-b px-4 py-3 sm:px-8 sm:py-5">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold leading-tight">{t(active.labelKey)}</h2>
              <p className="text-muted-foreground text-sm">{t(active.descKey)}</p>
            </div>
            {/* Radix a11y requirement; visually redundant with the header above. */}
            <DialogDescription className="sr-only">{t("settings.desc")}</DialogDescription>
          </header>

          <div className="min-w-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-8 sm:py-7">
            {pane === "engine" && <LocalEngineSection onInstallDone={handleInstallDone} />}

            {pane === "runtime" && (
              <EngineRuntimeSection
                value={draft.engineRuntime}
                onChange={(next: EngineRuntimeSettings) =>
                  setDraft((d) => ({ ...d, engineRuntime: next }))
                }
              />
            )}

            {pane === "credits" && <CreditsPane draft={draft} setDraft={setDraft} />}

            {pane === "wallet" &&
              (isWeb ? (
                <WebWalletSettings />
              ) : (
                <WalletPane onAddressChange={(address) => setDraft((prev) => ({ ...prev, walletAddress: address }))} />
              ))}

            {pane === "paths" && (
              <div className="ds-card grid gap-4 p-4">
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

            {pane === "storage" && <StorageSection draft={draft} setDraft={setDraft} />}
            {pane === "gallery" && isWeb && <WebGallerySection />}

            {pane === "tools" && <ToolsSection draft={draft} setDraft={setDraft} />}
            {pane === "agents" && !isWeb && <AgentsPane draft={draft} setDraft={setDraft} />}

            {pane === "language" && (
              <div className="ds-card grid gap-2 p-4">
                <Label htmlFor="lang">{t("settings.language")}</Label>
                <Select
                  id="lang"
                  fullWidth
                  className="max-w-xs"
                  value={langChoice}
                  onChange={(v) => {
                    setLangChoice(v);
                    setLanguage(v);
                  }}
                >
                  <option value="">{t("settings.languageSystem")}</option>
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </Select>
                <p className="text-muted-foreground text-xs">{t("settings.languageHint")}</p>
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-2 border-t px-4 py-3 sm:px-8">
            <span
              className={cn(
                "text-muted-foreground inline-flex items-center gap-1.5 text-xs transition-opacity duration-200",
                savedAt > 0 ? "opacity-100" : "opacity-0"
              )}
            >
              <Check className="size-3.5 text-success" /> {t("settings.saved")}
            </span>
            <Button onClick={() => onOpenChange(false)}>{t("common.done")}</Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
