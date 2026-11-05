// Catalog-driven generation parameters: formats, dimensions, price, defaults.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import type { FormatOption, ModelInfo } from "@/lib/types";
import type { TFunction } from "i18next";

// User-tweakable generation parameters, seeded from the selected model's catalog
// defaults and reset when the model changes.
export type GenParams = {
  prePrompt: string; // quality-tag prefix, prepended to the user prompt (client-side)
  formatCode: string; // a catalog format code, or "custom" (local only) for free dims
  /**
  * Steps and cfg — null when the catalog publishes no such knob for the model
  * (gpt-image-1 has neither, minimax-h3 no cfg). Null means "don't offer a
  * control, and don't send a value": the server then leaves the field out of
  * the worker payload instead of inventing one the model would ignore.
  */
  steps: number | null;
  cfg: number | null;
  negativePrompt: string;
  seedMode: "random" | "fixed";
  seed: number;
  clipSkip: number | null; // local only
  scheduler: string; // local only
  /**
   * Clip length in seconds — only for cloud video models that publish duration
   * bounds (durationDefault non-null). null everywhere else, and never sent.
   */
  durationS: number | null;
  // Free width/height when formatCode === "custom" (local only). Seeded from the
  // active preset, snapped to a multiple of 8 (latent constraint) at use.
  customWidth: number;
  customHeight: number;
};

// The "custom" pseudo-format (local only): free width/height instead of a preset.
export const CUSTOM_FORMAT = "custom";

// Generic formats used only when the catalog (im_format) carries none. Names
// are left empty so the UI resolves them via i18n (formatName below).
export const FALLBACK_FORMATS: FormatOption[] = [
  { formatCode: "square", name: "", width: 1024, height: 1024, ratio: "1:1", isDefault: true },
  { formatCode: "portrait", name: "", width: 832, height: 1216, ratio: "2:3", isDefault: false },
  { formatCode: "landscape", name: "", width: 1216, height: 832, ratio: "3:2", isDefault: false },
];

// WAN video generates at 480p video resolutions, NOT 1024² — a 1024² default is
// both wrong and far too heavy. Used only when the catalog carries no im_format
// rows for the WAN model; real catalog formats (when present) still win.
export const VIDEO_FALLBACK_FORMATS: FormatOption[] = [
  { formatCode: "landscape", name: "", width: 832, height: 480, ratio: "16:9", isDefault: true },
  { formatCode: "portrait", name: "", width: 480, height: 832, ratio: "9:16", isDefault: false },
];

// The WAN video backend (normalizeEngine maps im_engine "wan22"/"wan" → "wan").
export function isVideoModel(model: ModelInfo | null | undefined): boolean {
  return model?.backendType === "wan";
}

// Display name of a format: known codes are translated, otherwise the catalog
// name (server-provided) then the raw code.
export function formatName(f: FormatOption, t: TFunction): string {
  return t(`formats.${f.formatCode}`, { defaultValue: f.name || f.formatCode });
}

// The catalog (im_format) ships some ratio strings the wrong way round — a
// 896×1152 portrait is tagged "9:7". Trust the dimensions and flip the string
// when its orientation disagrees; a fixed catalog row is then a no-op.
export function formatRatio(f: FormatOption): string {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(f.ratio ?? "");
  if (!m || !f.width || !f.height) return f.ratio ?? "";
  const [a, b] = [Number(m[1]), Number(m[2])];
  const flipped = a > b !== f.width > f.height;
  return flipped ? `${b}:${a}` : `${a}:${b}`;
}

// orderedFormats sorts by SHAPE — widest first, down to tallest — instead of
// following the catalog's own `order`.
//
// That order alternates portrait and landscape (square, portrait, landscape,
// portrait-large, landscape-large, …), which laid out in a grid reads as
// unsorted. Grouping by orientation isn't enough either: an SDXL model's nine
// formats are all ~1 Mpx, so a size tie-break shuffles them arbitrarily
// (ultra-wide, then large, then normal, then wide). Ordering by aspect ratio
// gives one continuous progression — wide → square → tall — so the grid reads
// as a gradient of shapes, and the tie-break on pixel count keeps a model's
// quality tiers adjacent (minimax's SD sits next to its HD).
export function orderedFormats(formats: FormatOption[]): FormatOption[] {
  const ratio = (f: FormatOption) => (f.height > 0 ? f.width / f.height : 1);
  return [...formats].sort(
    (a, b) =>
      ratio(b) - ratio(a) ||
      a.width * a.height - b.width * b.height ||
      a.formatCode.localeCompare(b.formatCode)
  );
}

// A model's supported formats come from im_format; fall back to generic ones// A model's supported formats come from im_format; fall back to generic ones
// (video-specific for WAN, so a catalog missing its rows still defaults to 480p).
export function formatOptions(model: ModelInfo | null | undefined): FormatOption[] {
  if (model?.formats && model.formats.length > 0) return model.formats;
  return isVideoModel(model) ? VIDEO_FALLBACK_FORMATS : FALLBACK_FORMATS;
}

export function defaultFormatCode(model: ModelInfo): string {
  const opts = formatOptions(model);
  return (opts.find((o) => o.isDefault) ?? opts[0])?.formatCode ?? "square";
}

// Resolve a format code to its real per-model dimensions (im_format).
// runCost is what ONE generation costs, in credits. It mirrors creditCost in
// imference/app/api/pricing.go line for line — the price shown next to the
// Generate button has to be the price the server charges, and the server is the
// authority. Two catalog modifiers scale the model's base price:
//
//   • the selected FORMAT's credit_multiplier (1 in SD, 2 in HD);
//   • for models with a duration control, the requested length over the
//     model's default (5 s → ×1, 10 s → ×2, 15 s → ×3 on a 5 s-default model).
//
// The ceiling lands ONCE, on the whole product: rounding factor by factor would
// price the same clip differently depending on the order they were applied.
export function runCost(
  model: ModelInfo | null | undefined,
  formatCode: string,
  durationS: number | null
): number {
  if (!model || !(model.cost > 0)) return 0; // free / promotional stays free
  const fmt =
    (model.formats ?? []).find((f) => f.formatCode === formatCode) ??
    (model.formats ?? []).find((f) => f.isDefault);
  const m = fmt?.creditMultiplier;
  const formatMult = m != null && m > 0 ? m : 1;

  let durationMult = 1;
  const def = model.durationDefault;
  if (def != null && def > 0) {
    // Same clamp the request uses: an out-of-range ask is priced at the bound,
    // never above the maximum the model accepts.
    let d = durationS != null && durationS > 0 ? durationS : def;
    if (model.durationMin != null) d = Math.max(d, model.durationMin);
    if (model.durationMax != null) d = Math.min(d, model.durationMax);
    durationMult = d / def;
  }
  return Math.max(1, Math.ceil(model.cost * formatMult * durationMult));
}

export function dimsForModel(
  model: ModelInfo | null | undefined,
  formatCode: string
): { width: number; height: number } {
  const opts = formatOptions(model);
  const f = opts.find((o) => o.formatCode === formatCode) ?? opts.find((o) => o.isDefault) ?? opts[0];
  return f ? { width: f.width, height: f.height } : { width: 1024, height: 1024 };
}

// Clamp a free dimension to a diffusion-safe multiple of 8 within [256, 2048].
export function snapDim(n: number): number {
  const v = Math.round((Number.isFinite(n) ? n : 1024) / 8) * 8;
  return Math.max(256, Math.min(2048, v));
}

// The dimensions a generation will actually use: the picked preset, or the
// (snapped) free width/height when the user chose "custom".
export function resolveDims(
  model: ModelInfo | null | undefined,
  params: GenParams
): { width: number; height: number } {
  if (params.formatCode === CUSTOM_FORMAT) {
    return { width: snapDim(params.customWidth), height: snapDim(params.customHeight) };
  }
  return dimsForModel(model, params.formatCode);
}

// knob reads a catalog bound. Undefined means the model publishes no such
// control; so does a literal 0, which is what settings snapshots written before
// these fields became nullable still carry — and nothing legitimately defaults
// to zero steps, zero cfg or zero clip-skip.
export function knob(v: number | undefined): number | null {
  return v != null && v > 0 ? v : null;
}

// clampToCatalog holds a value inside the bounds the catalog published, leaving
// it alone when a bound is absent (unknown, not unlimited) or the value is 0
// (unspecified — the server fills in the model default).
export function clampToCatalog(v: number, min: number | undefined, max: number | undefined): number {
  if (!(v > 0)) return v;
  const lo = knob(min);
  const hi = knob(max);
  if (lo != null && v < lo) return lo;
  if (hi != null && v > hi) return hi;
  return v;
}

// isPinned reports that the catalog fixed a parameter: it published both bounds
// and left no room between them. Such a knob is a fact about the model, not a
// choice offered to the user — the UI shows it rather than pretending it moves.
export function isPinned(min: number | undefined, max: number | undefined): boolean {
  const lo = knob(min);
  const hi = knob(max);
  return lo != null && hi != null && hi <= lo;
}

// defaultParams seeds the tweakable params from a model's catalog config.
export function defaultParams(model: ModelInfo): GenParams {
  const d = dimsForModel(model, defaultFormatCode(model));
  return {
    prePrompt: model.promptPre || "",
    formatCode: defaultFormatCode(model),
    steps: knob(model.stepsDefault),
    cfg: knob(model.cfgDefault),
    negativePrompt: model.promptNegative || "",
    seedMode: "random",
    seed: 0,
    clipSkip: knob(model.skipDefault),
    scheduler: model.schedulerDefault || "",
    // null = this model has no duration control (the catalog's own signal).
    durationS: model.durationDefault ?? null,
    customWidth: d.width,
    customHeight: d.height,
  };
}
