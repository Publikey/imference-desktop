// Small shared pieces of the editing-tools UI: the Local / Local (slow) / Cloud
// badge, the per-tool icon, the price label, and the tool list used by both the
// gallery's right-click menu and the lightbox's Edit menu.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Cloud,
  Combine,
  Cpu,
  Crop,
  Eraser,
  Expand,
  FileText,
  FileVideo,
  Film,
  Gauge,
  ImageMinus,
  ImageUpscale,
  Layers,
  MousePointerClick,
  Paintbrush,
  Ruler,
  ScanFace,
  Scissors,
  ShieldOff,
  Shuffle,
  Sparkles,
  Wand2,
} from "lucide-react";
import { ChevronDown } from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { EDIT_TOOL_IDS, UTILITY_TOOL_IDS, VIDEO_TOOL_IDS, toolById, useTools } from "@/lib/tools";
import { cn, creditsToUSD } from "@/lib/utils";
import type { PaymentMode, ToolBadge as Badge, ToolInfo } from "@/lib/types";

const ICONS: Record<string, typeof Wand2> = {
  upscale: ImageUpscale,
  vary: Shuffle,
  "remove-background": ImageMinus,
  "erase-object": Eraser,
  segment: MousePointerClick,
  outpaint: Expand,
  inpaint: Paintbrush,
  "restore-faces": ScanFace,
  describe: FileText,
  resize: Ruler,
  crop: Crop,
  convert: Layers,
  "strip-metadata": ShieldOff,
  "video-trim": Scissors,
  "video-convert": FileVideo,
  "video-concat": Combine,
  interpolate: Film,
  "instruct-edit": Sparkles,
};

export function ToolIcon({ id, className }: { id: string; className?: string }) {
  const Icon = ICONS[id] ?? Wand2;
  return <Icon className={className} />;
}

/** The tool's display name (translated when the locale has it). */
export function toolName(t: TFunction, tool: Pick<ToolInfo, "id" | "name">): string {
  return t(`tools.names.${tool.id}`, { defaultValue: tool.name });
}

/** "Local" / "Local (slow)" / "Cloud" / "Unavailable" chip. */
export function ToolBadgeChip({ badge, className }: { badge: Badge; className?: string }) {
  const { t } = useTranslation();
  const style: Record<Badge, string> = {
    local: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    local_slow: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    cloud: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    unavailable: "border-border bg-muted text-muted-foreground",
  };
  const Icon = badge === "cloud" ? Cloud : badge === "local_slow" ? Gauge : Cpu;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4",
        style[badge],
        className
      )}
    >
      {badge !== "unavailable" && <Icon className="size-2.5" />}
      {t(`tools.badge.${badge}`)}
    </span>
  );
}

/** The cloud price, in the user's payment rail. */
export function formatToolPrice(
  t: TFunction,
  credits: number,
  rail: PaymentMode | string,
  isModelPrice?: boolean
): string {
  if (isModelPrice && credits <= 0) return t("tools.priceModel");
  if (rail === "x402") return `$${creditsToUSD(credits)}`;
  return t("tools.credits", { count: credits });
}

/** The user's payment rail, for price labels. */
export function usePaymentRail(): PaymentMode {
  const [rail, setRail] = useState<PaymentMode>("bearer");
  useEffect(() => {
    void api
      .getSettings()
      .then((s) => setRail(s.paymentMode === "x402" ? "x402" : "bearer"))
      .catch(() => {});
    return api.onSettingsChanged((s) => setRail(s.paymentMode === "x402" ? "x402" : "bearer"));
  }, []);
  return rail;
}

/** One row of a tool menu: icon, name, badge, cloud price. */
export function ToolMenuRow({
  tool,
  rail,
  onClick,
  dark,
}: {
  tool: ToolInfo;
  rail: PaymentMode;
  onClick: () => void;
  /** Lightbox styling (white on black). */
  dark?: boolean;
}) {
  const { t } = useTranslation();
  const disabled = tool.badge === "unavailable";
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={tool.reason ? t(`tools.reason.${tool.reason}`, { defaultValue: tool.description }) : tool.description}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors [&_svg]:size-4 disabled:opacity-50",
        dark ? "text-white hover:bg-white/10" : "text-foreground hover:bg-accent"
      )}
    >
      <span className={cn("shrink-0", dark ? "text-white/70" : "text-muted-foreground")}>
        <ToolIcon id={tool.id} />
      </span>
      {/* Where it runs and its price belong to the Edit panel, not the menu. */}
      <span className="min-w-0 flex-1 truncate">{toolName(t, tool)}</span>
    </button>
  );
}

/**
 * The "Edit" group of the gallery menus: the main image tools (or the video
 * tools for a clip) with badges and cloud prices, plus "More tools…" which
 * unfolds the utilities in place. "Click to select" opens the magic eraser in
 * select mode (onPick's second argument).
 */
export function ToolMenuList({
  kind,
  onPick,
  dark,
}: {
  kind?: string;
  onPick: (toolId: string, maskMode?: "select") => void;
  dark?: boolean;
}) {
  const { t } = useTranslation();
  const tools = useTools();
  const rail = usePaymentRail();
  const [more, setMore] = useState(false);
  const video = kind === "video";
  const main = (video ? VIDEO_TOOL_IDS.filter((id) => id !== "video-concat") : EDIT_TOOL_IDS)
    .map((id) => toolById(tools, id))
    .filter((x): x is ToolInfo => !!x);
  const extra = video
    ? []
    : UTILITY_TOOL_IDS.map((id) => toolById(tools, id)).filter((x): x is ToolInfo => !!x);
  const pick = (id: string) => (id === "segment" ? onPick("erase-object", "select") : onPick(id));
  if (tools.length === 0) {
    return (
      <div className={cn("px-2.5 py-1.5 text-xs", dark ? "text-white/60" : "text-muted-foreground")}>
        {t("tools.loading")}
      </div>
    );
  }
  return (
    <div role="group" aria-label={t("tools.edit")}>
      {main.map((tool) => (
        <ToolMenuRow key={tool.id} tool={tool} rail={rail} dark={dark} onClick={() => pick(tool.id)} />
      ))}
      {extra.length > 0 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMore((m) => !m);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
              dark ? "text-white/80 hover:bg-white/10" : "text-muted-foreground hover:bg-accent"
            )}
          >
            <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} />
            {t("tools.moreTools")}
          </button>
          {more &&
            extra.map((tool) => (
              <ToolMenuRow key={tool.id} tool={tool} rail={rail} dark={dark} onClick={() => pick(tool.id)} />
            ))}
        </>
      )}
    </div>
  );
}
