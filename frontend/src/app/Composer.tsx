// The prompt composer and the primary run button.
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { FieldLabel, Section } from "@/components/ds";
import { LaunchBurst, useLaunchBurst } from "@/components/LaunchBurst";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CornerDownLeft, Download, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerAction, Mode } from "./shared";

// ---------------------------------------------------------------------------
// Composer — the prompt input + primary action. Mode lives in the header,
// not here; several generations can be launched back-to-back.
// ---------------------------------------------------------------------------

// Grow a textarea to fit its content (clamped by the element's CSS min/max-h),
// re-measuring whenever the value changes — including external edits like
// "reuse settings" or an img2img drop that repopulate the prompt.
export function useAutoGrow(value: string, remeasure?: unknown) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight excludes the borders while the fields are border-box: without
    // them the box is 2px short and shows a scrollbar on a single line. Past
    // max-height the CSS cap wins and the scrollbar is real.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value, remeasure]);
  return ref;
}

// Composer — prompting only: quality tags, the prompt itself, and the negative
// prompt. Reference images (RefImageCard) and the run button (PrimaryAction) are
// siblings in the Create panel, not tenants of this card: mixing an image
// dropzone into a stack of text fields made both harder to read.
export function Composer({
  prompt,
  onPromptChange,
  showModelFields,
  prePrompt,
  onPrePromptChange,
  negativePrompt,
  onNegativePromptChange,
}: {
  prompt: string;
  onPromptChange: (v: string) => void;
  showModelFields: boolean;
  prePrompt: string;
  onPrePromptChange: (v: string) => void;
  negativePrompt: string;
  onNegativePromptChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  // ⌘/Ctrl+Enter is handled globally in App (works from anywhere, not just this
  // field), so the textarea needs no key handler of its own.
  // Negative prompt + quality tags. Most models pre-fill them, so "has a
  // value" can't decide: folded by default, with a note when they are in use.
  const [extrasOpen, setExtrasOpen] = useState(false);
  const promptRef = useAutoGrow(prompt);
  const preRef = useAutoGrow(prePrompt, extrasOpen);
  const negRef = useAutoGrow(negativePrompt, extrasOpen);
  const extrasSet = !!(negativePrompt.trim() || prePrompt.trim());
  const secondaryField =
    "ds-field block max-h-24 w-full resize-none px-3 py-1.5 text-xs leading-snug";

  return (
    <Section
      className="composer"
      title={t("composer.prompt")}
      help={t("composer.promptHelp")}
      action={
        prompt.length > 0 && (
          <>
            <span className="text-muted-foreground/60 text-[10px] tabular-nums">
              {t("composer.charCount", { count: prompt.length })}
            </span>
            <button
              type="button"
              onClick={() => onPromptChange("")}
              title={t("composer.clear")}
              aria-label={t("composer.clear")}
              className="text-muted-foreground/60 hover:text-foreground hover:bg-muted rounded p-0.5 transition-colors"
            >
              <X className="size-3.5" />
            </button>
          </>
        )
      }
    >

      {/* The prompt is the hero: no well of its own inside the card — the card
          is the field (it takes the focus ring, .composer:focus-within). */}
      <textarea
        id="composer-prompt"
        data-blocker="prompt"
        aria-label={t("composer.prompt")}
        ref={promptRef}
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder={t("composer.promptPlaceholder")}
        rows={3}
        className="composer-input mt-2 block max-h-72 min-h-24 w-full resize-none bg-transparent text-[0.9375rem] leading-relaxed outline-none"
      />

      {/* Negative prompt and quality tags: folded away until wanted. */}
      {showModelFields && !extrasOpen && (
        <div className="mt-2 flex">
          <button
            type="button"
            onClick={() => setExtrasOpen(true)}
            aria-expanded={false}
            aria-controls="composer-extras"
            className="text-muted-foreground hover:text-foreground -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium transition-colors"
          >
            <Plus className="size-3.5" />
            {t("composer.extras")}
            {extrasSet && <span className="text-subtle font-normal">· {t("composer.extrasSet")}</span>}
          </button>
        </div>
      )}

      {showModelFields && extrasOpen && (
        <div id="composer-extras" className="mt-3 grid gap-2.5 border-t pt-3">
          <div>
            <FieldLabel label={t("composer.negativePrompt")} help={t("composer.negativeHelp")} htmlFor="composer-negative" />
            <textarea
              id="composer-negative"
              ref={negRef}
              value={negativePrompt}
              onChange={(e) => onNegativePromptChange(e.target.value)}
              placeholder={t("composer.negativePlaceholder")}
              rows={1}
              className={secondaryField}
            />
          </div>
          <div>
            <FieldLabel label={t("composer.qualityTags")} help={t("composer.qualityTagsHelp")} htmlFor="composer-quality" />
            <textarea
              id="composer-quality"
              ref={preRef}
              value={prePrompt}
              onChange={(e) => onPrePromptChange(e.target.value)}
              placeholder={t("composer.qualityTagsPlaceholder")}
              rows={1}
              className={secondaryField}
            />
          </div>
          <button
            type="button"
            onClick={() => setExtrasOpen(false)}
            aria-expanded
            aria-controls="composer-extras"
            className="text-muted-foreground hover:text-foreground justify-self-start text-xs font-medium transition-colors"
          >
            {t("composer.extrasHide")}
          </button>
        </div>
      )}
    </Section>
  );
}

// PrimaryAction — one big full-width run button, pinned to the bottom of
// whatever scrolls the Create surface (the column on xl, the window below), so
// the click always follows the user however long the panel grows. The context
// hint (model · format · price) is its second line. It takes the mode's colour
// (Local blue / Cloud deep cyan), like the comet it launches and the Activity
// widget. Disabled, it stays opaque and readable: a quiet mode-tinted surface
// with a dashed outline instead of a faded gradient. Below xl, the right lane
// stays free for the Activity dock (z-40) — a narrower lane on phones, where
// the dock is icon-only.
export function PrimaryAction({
  action,
  contextHint,
  mode,
}: {
  action: ComposerAction;
  contextHint: string;
  mode: Mode;
}) {
  const burst = useLaunchBurst("generate");
  return (
    <div className="run-dock sticky bottom-0 z-30 pb-3 xl:-bottom-6 xl:pb-9 max-sm:pr-[4.5rem] sm:max-xl:pr-36">
      <span className="relative block w-full rounded-2xl" data-mode={mode}>
        <LaunchBurst burst={burst} />
        <Button
          size="lg"
          // aria-disabled, not disabled: a disabled button gets no click, and
          // the click is what points at what's missing.
          onClick={action.disabled ? action.onBlocked : action.onClick}
          aria-disabled={action.disabled}
          data-launch="generate"
          data-mode={mode}
          className={cn(
            // Colours come from .btn-run (index.css) through these two variables,
            // so the Button variant's utilities can't override the run states.
            "btn-run relative flex h-auto min-h-14 w-full flex-col gap-0.5 overflow-hidden whitespace-normal rounded-2xl bg-[var(--run-bg)] px-5 py-2.5 font-semibold text-[color:var(--run-fg)] hover:bg-[var(--run-bg)]",
            burst > 0 && "btn-launch"
          )}
          key={`gen-${burst}`}
        >
          {burst > 0 && <span aria-hidden className="launch-shine pointer-events-none absolute inset-0" />}
          <span className="flex items-center gap-2 text-base">
            {action.busy ? (
              <Loader2 className="size-4 shrink-0 animate-spin" />
            ) : action.kind === "download" ? (
              <Download className="size-4 shrink-0" />
            ) : (
              <Sparkles className="size-4 shrink-0" />
            )}
            {action.label}
            {action.kind === "generate" && !action.disabled && (
              <kbd className="run-kbd hidden shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex">
                <CornerDownLeft className="size-2.5" />
              </kbd>
            )}
          </span>
          <span className="run-hint max-w-full truncate text-[11px] font-medium" title={contextHint}>
            {contextHint}
          </span>
        </Button>
      </span>
    </div>
  );
}
