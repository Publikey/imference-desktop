// The window header: mode switch, engine control, panel toggles, utilities.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import logoUrl from "@/assets/logo.svg";
import { modLabel } from "@/components/CommandPalette";
import type { PanelId } from "@/components/PanelBoard";
import { PanelToggles } from "@/components/PanelToggles";
import { Button } from "@/components/ui/button";
import { SUPPORTED_LANGUAGES, setLanguage } from "@/i18n";
import { isWeb } from "@/lib/target";
import { isDark, setThemePref, subscribeTheme, type ThemePref } from "@/lib/theme";
import type { SidecarStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SegGroup, SegItem } from "@/components/ds";
import {
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
import { useSyncExternalStore } from "react";
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
  onInstallEngine,
  onStartEngine,
  onStopEngine,
  onSelectModel,
  errorLogCount,
  onToggleLogs,
  onOpenSettings,
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
  onInstallEngine: () => void;
  onStartEngine: () => void;
  onStopEngine: () => void;
  onSelectModel: () => void;
  errorLogCount: number;
  onToggleLogs: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  panelHidden: Partial<Record<PanelId, boolean>>;
  onTogglePanel: (id: PanelId) => void;
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  const { t } = useTranslation();
  // One system for the whole bar: every control is 36px high (h-9) with the
  // same radius; three zones — where things run (left), which panels are
  // shown (centre, exactly centred), app utilities as uniform icon buttons
  // (right). On a phone the bar is a plain row (no centred grid, it can't fit)
  // and keeps only what a touch user needs: the panel switches, theme, logs and
  // settings — the command palette and the language live in Settings / need a
  // keyboard anyway, and the web app has a single (cloud) mode to show.
  const iconBtn = "text-muted-foreground hover:text-foreground hover:bg-muted relative size-9 rounded-lg";
  return (
    <header className="bg-background/70 supports-[backdrop-filter]:bg-background/55 sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b px-3 backdrop-blur-xl sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        {/* Logo + app version stacked — the version is important operational info. */}
        <div className="flex shrink-0 flex-col items-center leading-none">
          <img src={logoUrl} alt="Imference" className="size-7" />
          <span className="text-muted-foreground mt-0.5 text-[10px] tabular-nums" title={isWeb ? undefined : t("header.versionTitle")}>
            {isWeb ? "Web" : appVersion === "dev" ? "dev" : appVersion ? `v${appVersion}` : ""}
          </span>
        </div>
        {/* The global mode: where everything runs. */}
        <SegGroup role="radiogroup" label={t("header.modeGroup")} className={cn("h-9 shrink-0", isWeb && "max-sm:hidden")}>
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
            onInstall={onInstallEngine}
            onStart={onStartEngine}
            onStop={onStopEngine}
            onSelectModel={onSelectModel}
          />
        )}
      </div>

      {/* Panel switches: Engine / Create / Edit / Gallery on or off. */}
      <PanelToggles hidden={panelHidden} onToggle={onTogglePanel} modLabel={modLabel} />

      <div className="flex shrink-0 items-center justify-end gap-0.5 sm:gap-1">
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
        <ThemeToggle />
        <LanguageToggle />
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleLogs}
          aria-label={errorLogCount > 0 ? t("header.logsWithErrors", { count: errorLogCount }) : t("common.logs")}
          title={errorLogCount > 0 ? t("header.errors", { count: errorLogCount }) : t("common.logs")}
          className={iconBtn}
        >
          <ScrollText className="size-4" />
          {errorLogCount > 0 && (
            <span className="bg-destructive ring-background absolute right-1.5 top-1.5 size-2 rounded-full ring-2" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          title={t("common.settings")}
          aria-label={t("common.settings")}
          className={iconBtn}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}

// LanguageToggle — cycles through SUPPORTED_LANGUAGES from the header. It sets
// an explicit (persisted) choice, exactly like picking a language in Settings;
// "follow the system" remains available there.
export function LanguageToggle() {
  const { i18n } = useTranslation();
  const idx = SUPPORTED_LANGUAGES.findIndex((l) => l.code === i18n.language);
  const current = SUPPORTED_LANGUAGES[idx] ?? SUPPORTED_LANGUAGES[0];
  const next = SUPPORTED_LANGUAGES[(Math.max(idx, 0) + 1) % SUPPORTED_LANGUAGES.length];
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setLanguage(next.code)}
      // The next language names itself (中文 reads it in Chinese, English in
      // English), so the tooltip stays readable before AND after switching.
      title={next.label}
      // The name starts with the visible code (WCAG 2.5.3, label in name).
      aria-label={`${current.short} · ${next.label}`}
      className="text-muted-foreground hover:text-foreground hover:bg-muted size-9 rounded-lg p-0 text-[11px] font-semibold max-sm:hidden"
    >
      {current.short}
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

// EngineControl — the local engine's status *and* its lifecycle switch. Because
// the backend (sdxl/zimage/wan) and weights are chosen BY the model, "starting
// the engine" means "load the selected model"; there is no model-agnostic start.
// So: not installed → Install · no model → Select a model · model ready, stopped
// → Start (loads it) · running → Stop (frees VRAM).
export function EngineControl({
  status,
  engineInstalled,
  installing,
  hasLocalModel,
  onInstall,
  onStart,
  onStop,
  onSelectModel,
}: {
  status: SidecarStatus;
  engineInstalled: boolean;
  installing: boolean;
  hasLocalModel: boolean;
  onInstall: () => void;
  onStart: () => void;
  onStop: () => void;
  onSelectModel: () => void;
}) {
  const { t } = useTranslation();
  // A shared floor width + centering so the pill keeps a stable footprint as the
  // engine moves through install → select → start → running (the left header
  // cluster no longer shifts on every state change).
  const pill =
    "inline-flex h-9 min-w-0 shrink items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium lg:min-w-[9.5rem] transition-[color,background-color,border-color] disabled:cursor-not-allowed disabled:opacity-50";

  if (installing) {
    return (
      <span className={cn(pill, "border-border text-muted-foreground")}>
        <Loader2 className="size-3 animate-spin" /> {t("engineControl.installing")}
      </span>
    );
  }
  if (!engineInstalled) {
    return (
      <button
        type="button"
        onClick={onInstall}
        className={cn(pill, "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20")}
      >
        <Download className="size-3" /> {t("engineControl.install")}
      </button>
    );
  }
  if (status.state === "starting") {
    return (
      <span className={cn(pill, "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300")}>
        <Loader2 className="size-3 animate-spin" /> {t("engineControl.starting")}
      </span>
    );
  }
  if (status.state === "ready") {
    return (
      <button
        type="button"
        onClick={onStop}
        title={t("engineControl.runningTitle", { device: status.device })}
        className={cn(
          pill,
          "group border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600 dark:text-emerald-300"
        )}
      >
        <span className="size-1.5 rounded-full bg-emerald-500 group-hover:hidden" />
        <Square className="hidden size-3 group-hover:inline" />
        <span className="group-hover:hidden">{t("engineControl.on")}</span>
        <span className="hidden group-hover:inline">{t("engineControl.stop")}</span>
      </button>
    );
  }
  // No downloaded model → "start" is meaningless (the model picks the backend +
  // weights). Guide to model selection instead of a dead greyed button.
  if (!hasLocalModel) {
    return (
      <button
        type="button"
        onClick={onSelectModel}
        title={t("engineControl.selectModelTitle")}
        className={cn(pill, "border-border text-muted-foreground hover:text-foreground hover:border-primary/40")}
      >
        <Cpu className="size-3" /> {t("engineControl.selectModel")}
      </button>
    );
  }

  // Model ready but engine stopped / errored → Start (loads that model).
  const isError = status.state === "error";
  const errMsg = status.state === "error" ? status.message : undefined;
  return (
    <button
      type="button"
      onClick={onStart}
      title={errMsg || t("engineControl.startTitle")}
      className={cn(
        pill,
        isError
          ? "border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10"
          : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
      )}
    >
      <Play className="size-3" />
      {isError ? t("engineControl.restart") : t("engineControl.start")}
    </button>
  );
}
