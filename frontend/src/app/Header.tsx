// The window header: mode switch, engine control, panel toggles, utilities.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import logoUrl from "@/assets/logo.svg";
import { modLabel } from "@/components/CommandPalette";
import type { PanelId } from "@/components/PanelBoard";
import { PanelToggles } from "@/components/PanelToggles";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/lib/target";
import { api } from "@/lib/wails-bridge";
import { isDark, setThemePref, subscribeTheme, type ThemePref } from "@/lib/theme";
import type { ModelInfo, SidecarStatus } from "@/lib/types";
import { EngineDetails } from "@/components/EnginePanel";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SegGroup, SegItem } from "@/components/ds";
import {
  Bot,
  ChevronDown,
  Cloud,
  Cpu,
  Download,
  Loader2,
  Moon,
  Play,
  ScrollText,
  Search,
  Settings,
  Square,
  Sun,
} from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { Mode } from "./shared";

// ---------------------------------------------------------------------------
// Header — frosted, sticky, content-deferential.
// ---------------------------------------------------------------------------

export function Header({
  appVersion,
  sidecar,
  engineInstalled,
  installing,
  hasLocalModel,
  engineModel,
  loraCount,
  onInstallEngine,
  onStartEngine,
  onStopEngine,
  onSelectModel,
  errorLogCount,
  onToggleLogs,
  onOpenSettings,
  onOpenAgents,
  onOpenPalette,
  panelHidden,
  onTogglePanel,
  mode,
  onModeChange,
}: {
  appVersion: string;
  sidecar: SidecarStatus;
  engineInstalled: boolean;
  installing: boolean;
  hasLocalModel: boolean;
  engineModel: ModelInfo | null | undefined;
  loraCount: number;
  onInstallEngine: () => void;
  onStartEngine: () => void;
  onStopEngine: () => void;
  onSelectModel: () => void;
  errorLogCount: number;
  onToggleLogs: () => void;
  onOpenSettings: () => void;
  /** Settings › AI agents (desktop). */
  onOpenAgents?: () => void;
  onOpenPalette: () => void;
  panelHidden: Partial<Record<PanelId, boolean>>;
  onTogglePanel: (id: PanelId) => void;
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  const { t } = useTranslation();
  // One system for the whole bar: every control is 36px high (h-9) with the
  // same radius; three zones — where things run (left), which panels are
  // shown (centre, exactly centred), a few uniform icon buttons (right):
  // commands, theme, settings. The language is in the palette and Settings,
  // the logs in the palette (and back here, flagged, when something fails). On a phone
  // the bar is a plain row with the panel switches, theme and settings.
  const iconBtn = "text-muted-foreground hover:text-foreground hover:bg-muted relative size-9 rounded-lg";
  return (
    <header className="bg-background/70 supports-[backdrop-filter]:bg-background/55 sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b px-3 backdrop-blur-xl sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        {/* The mark alone; the version is in its tooltip and in Settings. */}
        <img
          src={logoUrl}
          alt="Imference"
          title={isWeb ? "Imference Web" : `Imference Desktop${appVersion ? (appVersion === "dev" ? " (dev)" : ` v${appVersion}`) : ""}`}
          className="size-7 shrink-0"
        />
        {/* The global mode: where everything runs. */}
        <SegGroup role="radiogroup" label={t("header.modeGroup")} className="h-9 shrink-0 max-sm:hidden">
          {(["local", "cloud"] as const).map((m) => (
            <SegItem
              key={m}
              on={mode === m}
              data-mode={m}
              disabled={isWeb && m === "local"}
              onClick={() => onModeChange(m)}
              title={t(m === "local" ? "header.modeLocalTitle" : "header.modeCloudTitle")}
              className={cn("h-[30px] px-3 font-semibold disabled:hidden", mode === m && "mode-chip")}
            >
              {m === "local" ? <Cpu className="size-3.5" /> : <Cloud className="size-3.5" />}
              {t(m === "local" ? "mode.local" : "mode.cloud")}
            </SegItem>
          ))}
        </SegGroup>
        {/* The local engine's status and start / stop: local mode only. */}
        {!isWeb && mode === "local" && (
          <EngineControl
            status={sidecar}
            engineInstalled={engineInstalled}
            installing={installing}
            hasLocalModel={hasLocalModel}
            engineModel={engineModel}
            loraCount={loraCount}
            onInstall={onInstallEngine}
            onStart={onStartEngine}
            onStop={onStopEngine}
            onSelectModel={onSelectModel}
          />
        )}
      </div>

      {/* Panel switches: Create / Edit / Gallery on or off. */}
      <PanelToggles hidden={panelHidden} onToggle={onTogglePanel} modLabel={modLabel} />

      <div className="flex shrink-0 items-center justify-end gap-0.5 sm:gap-1">
        {/* AI agents: a headline feature, so named and set apart (desktop). */}
        {!isWeb && onOpenAgents && <AgentsButton onClick={onOpenAgents} />}
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenPalette}
          title={`${t("palette.title")} (${modLabel}K)`}
          aria-label={t("palette.title")}
          className={cn(iconBtn, "max-sm:hidden")}
        >
          <Search className="size-4" />
        </Button>
        {/* Logs: in the palette; here only when something failed. */}
        {errorLogCount > 0 && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleLogs}
            aria-label={t("header.logsWithErrors", { count: errorLogCount })}
            title={t("header.errors", { count: errorLogCount })}
            className={iconBtn}
          >
            <ScrollText className="size-4" />
            <span className="bg-destructive ring-background absolute right-1.5 top-1.5 size-2 rounded-full ring-2" />
          </Button>
        )}
        <ThemeToggle />
        {/* The main utility: named, not just an icon (icon only on phones). */}
        <Button
          variant="ghost"
          onClick={onOpenSettings}
          title={t("common.settings")}
          className="text-muted-foreground hover:text-foreground hover:bg-muted h-9 gap-2 rounded-lg px-2.5 max-sm:w-9 max-sm:px-0"
        >
          <Settings className="size-4" />
          <span className="max-sm:sr-only">{t("common.settings")}</span>
        </Button>
      </div>
    </header>
  );
}

// AgentsButton — opens Settings › AI agents. A green dot once an AI app is
// connected (checked at launch and when the window gets focus back).
function AgentsButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const check = () =>
      void api
        .mcpStatus(false)
        .then((s) => setConnected(s.clients.some((c) => c.entries.some((e) => e.scope === "user"))))
        .catch(() => {});
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      title={t(connected ? "header.agentsConnected" : "header.agentsTitle")}
      data-testid="header-agents"
      className="agents-btn relative mr-1 h-9 gap-2 rounded-lg px-3 font-medium max-sm:w-9 max-sm:px-0"
    >
      <Bot className="size-4" />
      <span className="max-sm:sr-only">{t("header.agents")}</span>
      {connected && <span className="bg-success ring-background absolute right-1 top-1 size-2 rounded-full ring-2" />}
    </Button>
  );
}

// ThemeToggle — cycles the appearance System → Light → Dark from the header.
// The choice is persisted (localStorage); "System" follows the OS live. The
// icon shows the ACTIVE preference and the tooltip names what a click switches
// TO, so the control reads correctly before and after pressing it.
// A plain light ⇄ dark switch showing what you see now (sun / moon). The
// "system" preference (follow the OS) stays in the command palette; a click
// here always sets the opposite of what's on screen, so it never "does nothing"
// (cycling through "system" used to show a monitor and change nothing visible).
export function ThemeToggle() {
  const { t } = useTranslation();
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false);
  const next: ThemePref = dark ? "light" : "dark";
  const Icon = dark ? Moon : Sun;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setThemePref(next)}
      title={t("theme.switchTo", { mode: t(`theme.${next}`) })}
      aria-label={t("theme.switchTo", { mode: t(`theme.${next}`) })}
      className="text-muted-foreground hover:text-foreground hover:bg-muted size-9 rounded-lg"
    >
      <Icon className="size-4" />
    </Button>
  );
}

// EngineControl — the local engine's status, and the door to its details.
// Not installed → Install · no model → Select a model (both act directly).
// Otherwise the pill shows the state (dot + word) and opens a popover with the
// machine, the model the engine holds, its tool models, and Start / Stop.
export function EngineControl({
  status,
  engineInstalled,
  installing,
  hasLocalModel,
  engineModel,
  loraCount,
  onInstall,
  onStart,
  onStop,
  onSelectModel,
}: {
  status: SidecarStatus;
  engineInstalled: boolean;
  installing: boolean;
  hasLocalModel: boolean;
  engineModel: ModelInfo | null | undefined;
  loraCount: number;
  onInstall: () => void;
  onStart: () => void;
  onStop: () => void;
  onSelectModel: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  // A shared floor width so the pill keeps a stable footprint as the engine
  // moves through its states (the left cluster doesn't shift on each change).
  const pill =
    "inline-flex h-9 min-w-0 shrink items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-xs font-medium lg:min-w-[9.5rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  if (installing) {
    return (
      <span className={cn(pill, "text-muted-foreground")}>
        <Loader2 className="size-3.5 animate-spin" /> {t("engineControl.installing")}
      </span>
    );
  }
  if (!engineInstalled) {
    return (
      <button type="button" onClick={onInstall} className={cn(pill, "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15")}>
        <Download className="size-3.5" /> {t("engineControl.install")}
      </button>
    );
  }
  if (!hasLocalModel) {
    return (
      <button
        type="button"
        onClick={onSelectModel}
        title={t("engineControl.selectModelTitle")}
        className={cn(pill, "text-muted-foreground hover:text-foreground hover:border-border-strong")}
      >
        <Cpu className="size-3.5" /> {t("engineControl.selectModel")}
      </button>
    );
  }

  const state = status.state;
  const tone =
    state === "ready" ? "text-success" : state === "starting" ? "text-warning" : state === "error" ? "text-destructive" : "text-muted-foreground";
  const word =
    state === "ready"
      ? t("engineControl.on")
      : state === "starting"
        ? t("engineControl.starting")
        : state === "error"
          ? t("engineControl.error")
          : t("engineControl.off");

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-haspopup="dialog"
        title={t("engineControl.detailsTitle")}
        className={cn(pill, "hover:bg-muted text-foreground", open && "bg-muted")}
      >
        {state === "starting" ? (
          <Loader2 className={cn("size-3.5 animate-spin", tone)} />
        ) : (
          <span className={cn("size-2 rounded-full bg-current", tone, state === "ready" && "engine-dot-live")} />
        )}
        <span className="truncate">{word}</span>
        <ChevronDown className={cn("text-muted-foreground size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <Popover
        id={popId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        label={t("engineControl.detailsTitle")}
        className="w-80"
      >
        <div className="p-4">
          <EngineDetails sidecar={status} localModel={engineModel} loraCount={loraCount} />
        </div>
        <div className="bg-muted/40 flex items-center justify-end gap-2 rounded-b-2xl border-t px-4 py-3">
          {state === "error" && "message" in status && status.message && (
            <p className="text-destructive min-w-0 flex-1 truncate text-xs" title={status.message}>
              {status.message}
            </p>
          )}
          {state === "ready" || state === "starting" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={state === "starting"}
              onClick={() => {
                setOpen(false);
                onStop();
              }}
            >
              <Square /> {t("engineControl.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                onStart();
              }}
            >
              <Play /> {state === "error" ? t("engineControl.restart") : t("engineControl.start")}
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}
