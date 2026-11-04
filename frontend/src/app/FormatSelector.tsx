// Format (aspect / size) picker of the Create panel.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { SectionHeader } from "@/components/ds";
import type { ModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import {
  CUSTOM_FORMAT,
  type GenParams,
  dimsForModel,
  formatName,
  formatOptions,
  formatRatio,
  orderedFormats,
  snapDim,
} from "./model-params";
import type { Mode } from "./shared";

// AspectGlyph draws the format's actual proportions in a 14px box. A shape says
// "portrait, quite tall" faster than "9:13" does, and it costs no width in a
// cell that also has to hold a name and a pixel count.
export function AspectGlyph({
  width,
  height,
  active,
  size = 14,
}: {
  width: number;
  height: number;
  active: boolean;
  /** The longer side, in px. */
  size?: number;
}) {
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const scale = size / Math.max(w, h);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0 rounded-[2px] border",
        active ? "border-[var(--brand-to)] bg-[var(--brand-to)]/30" : "border-muted-foreground/50"
      )}
      style={{ width: Math.max(4, Math.round(w * scale)), height: Math.max(4, Math.round(h * scale)) }}
    />
  );
}

// FormatSelector — the image aspect (square / portrait / landscape …), pulled
// out of the collapsible Parameters so it's always one tap away, right under the
// prompt. Options and per-model dimensions come from the catalog (im_format),
// falling back to the generic set. In local mode a "Custom" option unlocks free
// width/height (the sidecar takes arbitrary dims; the cloud API doesn't).
export function FormatSelector({
  model,
  mode,
  params,
  onChange,
}: {
  model: ModelInfo;
  mode: Mode;
  params: GenParams;
  onChange: (patch: Partial<GenParams>) => void;
}) {
  const { t } = useTranslation();
  const formats = formatOptions(model);
  const allowCustom = mode === "local";
  const isCustom = params.formatCode === CUSTOM_FORMAT;
  if (formats.length <= 1 && !allowCustom) return null; // nothing to choose

  // Entering custom seeds the free dims from the preset currently in view.
  const enterCustom = () => {
    if (isCustom) return;
    const d = dimsForModel(model, params.formatCode);
    onChange({ formatCode: CUSTOM_FORMAT, customWidth: d.width, customHeight: d.height });
  };

  const current = isCustom ? { width: params.customWidth, height: params.customHeight } : dimsForModel(model, params.formatCode);
  const tile = (active: boolean, dashed = false) =>
    cn(
      "flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border px-1 transition-colors",
      active
        ? "border-[var(--brand-to)] bg-[var(--brand-to)]/10 text-foreground"
        : cn("border-border/70 text-muted-foreground hover:text-foreground hover:bg-muted/50", dashed && "border-dashed")
    );

  return (
    <section className="ds-card px-4 py-3">
      <div className="flex flex-col gap-2.5">
        <SectionHeader
          title={t("params.format")}
          help={t("params.formatHelp")}
          action={
            <span className="text-muted-foreground text-xs tabular-nums">
              {current.width}×{current.height}
            </span>
          }
        />
        {/* Equal tiles, as many per row as fit: a shape and a name, the pixels
            in the tooltip and, for the chosen one, in the header. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-1.5">
          {orderedFormats(formats).map((f) => {
            const active = !isCustom && params.formatCode === f.formatCode;
            return (
              <button
                key={f.formatCode}
                type="button"
                onClick={() => onChange({ formatCode: f.formatCode })}
                title={`${formatName(f, t)} · ${f.width}×${f.height}${f.ratio ? ` · ${formatRatio(f)}` : ""}`}
                aria-pressed={active}
                className={tile(active)}
              >
                <span className="flex h-5 items-center">
                  <AspectGlyph width={f.width} height={f.height} active={active} size={18} />
                </span>
                <span className="w-full truncate text-center text-[11px] font-medium capitalize sm:text-xs">{formatName(f, t)}</span>
              </button>
            );
          })}
          {allowCustom && (
            <button
              type="button"
              onClick={enterCustom}
              aria-pressed={isCustom}
              title={t("formats.freeDims")}
              className={tile(isCustom, true)}
            >
              <span className="flex h-5 items-center">
                <AspectGlyph width={params.customWidth} height={params.customHeight} active={isCustom} size={18} />
              </span>
              <span className="w-full truncate text-center text-[11px] font-medium sm:text-xs">{t("formats.custom")}</span>
            </button>
          )}
        </div>
      </div>

      {/* Free width × height (local, custom only). Snap to a multiple of 8 on
          blur; the value is re-snapped at generation regardless. */}
      {isCustom && (
        <div className="mt-2.5 flex items-center gap-2">
          <DimInput
            label={t("params.width")}
            value={params.customWidth}
            onChange={(customWidth) => onChange({ customWidth })}
            onCommit={(customWidth) => onChange({ customWidth: snapDim(customWidth) })}
          />
          <span className="text-muted-foreground/60 mt-4 shrink-0 text-xs">×</span>
          <DimInput
            label={t("params.height")}
            value={params.customHeight}
            onChange={(customHeight) => onChange({ customHeight })}
            onCommit={(customHeight) => onChange({ customHeight: snapDim(customHeight) })}
          />
        </div>
      )}
    </section>
  );
}

// A single labelled width/height number input for the custom format. Typing sets
// the raw value (so you can type freely); blur/Enter snaps it to a valid dim.
export function DimInput({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="ds-sublabel">{label}</span>
      <input
        type="number"
        min={256}
        max={2048}
        step={8}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        onBlur={(e) => onCommit(Number(e.target.value) || 512)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="border-input bg-background field-focus h-8 w-full rounded-md border px-2 text-xs tabular-nums"
      />
    </label>
  );
}
