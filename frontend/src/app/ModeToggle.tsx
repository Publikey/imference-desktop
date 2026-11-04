// The Local / Cloud switch inside the Engine panel.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { cn } from "@/lib/utils";
import { Cloud, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Mode } from "./shared";

// ModeToggle — the primary local/cloud switch, at the top of the form and the
// single source of truth for mode (not repeated in the composer).
export function ModeToggle({
  mode,
  onModeChange,
  localReady,
  cloudReady,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  localReady: boolean;
  cloudReady: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-muted grid grid-cols-2 gap-1 rounded-2xl p-1 text-sm">
      <SegBtn
        active={mode === "local"}
        ready={localReady}
        tone="brand"
        onClick={() => onModeChange("local")}
        icon={<Cpu className="size-4" />}
        label={t("mode.local")}
      />
      <SegBtn
        active={mode === "cloud"}
        ready={cloudReady}
        tone="cloud"
        onClick={() => onModeChange("cloud")}
        icon={<Cloud className="size-4" />}
        label={t("mode.cloud")}
      />
    </div>
  );
}

export function SegBtn({
  active,
  ready,
  tone,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  ready: boolean;
  tone: "brand" | "cloud";
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  const { t } = useTranslation();
  // Concentric radii: rounded-2xl track − p-1 gap = rounded-xl thumb.
  return (
    <button
      type="button"
      onClick={onClick}
      // Readiness is shown on BOTH tabs (so you can see the other mode is ready
      // before switching) but always labelled via the title; the active mode is
      // carried by the accent + surface, not the dot.
      title={`${label} · ${ready ? t("mode.ready") : t("mode.notReady")}`}
      className={cn(
        "relative inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 font-medium transition-[color,background-color,box-shadow] duration-200",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      <span
        className={cn(
          active && (tone === "brand" ? "text-[var(--brand-from)]" : "text-[var(--cloud-from)]")
        )}
      >
        {icon}
      </span>
      {label}
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full transition-colors",
          ready ? "bg-emerald-500" : "bg-muted-foreground/30",
          !active && "opacity-60"
        )}
      />
    </button>
  );
}
