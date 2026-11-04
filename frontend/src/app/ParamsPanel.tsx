// Collapsible generation parameters (steps, guidance, seed, ...).
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { Checkbox } from "@/components/ui/checkbox";
import type { ModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type GenParams, defaultParams, isPinned, knob, resolveDims } from "./model-params";
import type { Mode } from "./shared";

// ParamsPanel — collapsible generation parameters, seeded from the model's
// catalog defaults (steps/cfg bounds, negative prompt) and tweakable per
// generation. Format now lives in its own always-visible FormatSelector above
// the prompt. Clip-skip / scheduler are local-only (the cloud API uses the
// model's server-side defaults).
export function ParamsPanel({
  model,
  mode,
  params,
  onChange,
}: {
  model: ModelInfo;
  mode: Mode;
  params: GenParams;
  onChange: (p: GenParams) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<GenParams>) => onChange({ ...params, ...patch });

  // A knob the catalog is silent about gets no control at all — showing one
  // that the model ignores is what made cfg look adjustable on minimax-h3.
  const stepsDefault = knob(model.stepsDefault);
  const showSteps = stepsDefault != null;
  const stepsMin = knob(model.stepsMin) ?? 1;
  const stepsMax = Math.max(knob(model.stepsMax) ?? 50, stepsMin + 1);
  // min == max is the catalog stating a REQUIREMENT, not offering a range —
  // wan22-t2v ships steps 6/6/6 and cfg 1/1/1. The floors above (min + 1,
  // min + 0.5) exist to keep a slider from being degenerate, and in doing so
  // they invented values the model doesn't accept: a 6–7 steps slider on a
  // model that only runs 6. When a knob is pinned, show the value instead.
  const stepsPinned = isPinned(model.stepsMin, model.stepsMax);
  // cfg 0 is a REAL value for guidance-off models (Krea 2 Turbo publishes
  // cfgDefault 0, cfgMin 0) — knob() would misread it as "unset" (that rule
  // exists for legacy snapshots whose EVERY field is 0). A published cfgMax > 0
  // marks the row as real, so trust its zero default/min then.
  const cfgRowIsReal = model.cfgMax != null && model.cfgMax > 0;
  const cfgDefault =
    cfgRowIsReal && model.cfgDefault != null ? model.cfgDefault : knob(model.cfgDefault);
  const showCfg = cfgDefault != null;
  const cfgMin = cfgRowIsReal && model.cfgMin != null ? model.cfgMin : (knob(model.cfgMin) ?? 1);
  const cfgMax = Math.max(knob(model.cfgMax) ?? 20, cfgMin + 0.5);
  const cfgPinned = isPinned(model.cfgMin, model.cfgMax);
  const showClip = knob(model.skipDefault) != null; // model uses clip-skip
  // The catalog decides whether a clip length is offered at all; the cloud
  // restriction is ours (see the control below).
  const durationDefault = model.durationDefault ?? 0;
  const showDuration = mode === "cloud" && model.durationDefault != null;
  const durationMin = model.durationMin ?? 1;
  const durationMax = Math.max(model.durationMax ?? durationDefault, durationMin + 1);
  const durationPinned = isPinned(model.durationMin, model.durationMax);
  const dims = resolveDims(model, params);
  // Built from the parts the model actually has, so the collapsed line doesn't
  // announce a "cfg 0" for a model that has no cfg.
  const summary = [
    `${dims.width}×${dims.height}`,
    showSteps ? t("params.summarySteps", { steps: params.steps ?? stepsDefault }) : null,
    showCfg ? t("params.summaryCfg", { cfg: params.cfg ?? cfgDefault }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="ds-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="ds-label">
            {t("params.title")}
          </span>
          <span className="text-muted-foreground/60 truncate text-[11px]">{summary}</span>
        </div>
        <ChevronDown
          className={cn("text-muted-foreground size-4 shrink-0 transition", open && "rotate-180")}
        />
      </button>

      {/* Animate open/close via a grid-rows 0fr→1fr collapse (auto-height, no JS
          measuring) so the body eases in to match the chevron rotation. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[var(--ease-out-expo)]",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="grid gap-4 border-t px-4 py-4">
            {showSteps &&
              (stepsPinned ? (
                <FixedRow label={t("params.steps")} value={String(stepsDefault)} />
              ) : (
                <RangeRow label={t("params.steps")} value={params.steps ?? stepsDefault} min={stepsMin} max={stepsMax} step={1} onChange={(v) => set({ steps: v })} />
              ))}
            {showCfg &&
              (cfgPinned ? (
                <FixedRow label={t("params.cfg")} value={String(cfgDefault)} />
              ) : (
                <div
                  className="grid gap-1"
                  title={model.backendType === "krea2" ? t("params.cfgZeroOffTitle") : undefined}
                >
                  <RangeRow label={t("params.cfg")} value={params.cfg ?? cfgDefault} min={cfgMin} max={cfgMax} step={0.5} onChange={(v) => set({ cfg: v })} />
                  {/* Krea 2 counts guidance from 0 (off = the Turbo recipe) while
                      civitai/ComfyUI recipes count from 1 (their CFG 1 == our 0) —
                      say it, or users will "match the recipe" and double their
                      step time re-enabling guidance. */}
                  {model.backendType === "krea2" && (
                    <p className="text-muted-foreground text-[11px] leading-snug">
                      {t("params.cfgZeroOffHint")}
                    </p>
                  )}
                </div>
              ))}

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{t("params.seed")}</span>
                <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-[11px]">
                  <Checkbox
                    checked={params.seedMode === "random"}
                    onCheckedChange={(c) => set({ seedMode: c ? "random" : "fixed" })}
                  />
                  {t("params.random")}
                </label>
              </div>
              {params.seedMode === "fixed" && (
                <input
                  type="number"
                  value={params.seed}
                  onChange={(e) => set({ seed: Number(e.target.value) || 0 })}
                  className="border-input bg-background field-focus h-8 rounded-md border px-2 text-xs tabular-nums"
                />
              )}
            </div>

            {/* Clip length — only when the catalog says the model takes one, and
                only in cloud mode: the local sidecar's generate() has no such
                kwarg, so a slider there would move nothing. */}
            {showDuration && durationPinned && (
              <FixedRow
                label={t("params.duration")}
                value={t("params.seconds", { count: durationDefault })}
              />
            )}
            {showDuration && !durationPinned && (
              <RangeRow
                label={t("params.duration")}
                value={params.durationS ?? durationDefault}
                min={durationMin}
                max={durationMax}
                step={1}
                format={(v) => t("params.seconds", { count: v })}
                onChange={(v) => set({ durationS: v })}
              />
            )}

            {mode === "local" && (
              <div className="grid gap-3 border-t pt-3">
                <span className="ds-label">
                  {t("params.advanced")}
                </span>
                {showClip && (
                  <RangeRow
                    label={t("params.clipSkip")}
                    value={params.clipSkip ?? knob(model.skipDefault) ?? 0}
                    min={0}
                    max={4}
                    step={1}
                    onChange={(v) => set({ clipSkip: v })}
                  />
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{t("params.scheduler")}</span>
                  {/* Informational (no scheduler list yet) — a value chip, not a
                      disabled input, so it doesn't read as interactive. */}
                  <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-[11px] font-medium">
                    {params.scheduler || t("params.modelDefault")}
                  </span>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => onChange(defaultParams(model))}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 justify-self-start text-[11px]"
            >
              <RotateCcw className="size-3" /> {t("params.reset")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// FixedRow shows a parameter the model pins: the same label as a slider, with a
// value chip instead of a track — the pattern the scheduler row already uses, so
// it reads as information rather than a disabled control.
export function FixedRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium">{label}</span>
      <span
        className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums"
        title={t("params.fixedByModel")}
      >
        {value}
      </span>
    </div>
  );
}

export function RangeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** Renders the value chip — for units the bare number doesn't carry (seconds). */
  format?: (v: number) => string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format ? format(value) : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range w-full"
      />
    </div>
  );
}
