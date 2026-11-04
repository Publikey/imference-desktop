// Reference-image slots (img2img, first/last frame).
// (Split out of App.tsx; see App.tsx for how the pieces fit together.)
import { AddButton, ComposerCardHeader } from "@/components/ComposerCard";
import { HoverPopover } from "@/components/ui/hover-popover";
import { prepareRefImage } from "@/lib/image";
import { cn } from "@/lib/utils";
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// Reference-image card inside the composer. One slot per image the model
// accepts (ModelInfo.refImages): one for img2img, two for a video model taking
// a first and last frame. Reference images are ALWAYS optional — the card says
// so, because an empty slot reads as something missing otherwise.
//
// Rendering slots from a count (rather than special-casing "the" source image)
// is what lets a two-image model land with no layout change.
export function RefImageCard({
  slots,
  images,
  onImagesChange,
  targetW,
  targetH,
  strength,
  onStrengthChange,
  showStrength = true,
}: {
  /** How many slots to render (1 or 2). The card isn't mounted at 0. */
  slots: number;
  /** Current images by slot; holes are empty slots. */
  images: (string | null)[];
  onImagesChange: (next: (string | null)[]) => void;
  /** The model's working resolution — incoming images are scaled to fit it. */
  targetW: number;
  targetH: number;
  strength: number;
  onStrengthChange: (v: number) => void;
  /** false: the model takes the image but has no strength knob (cloud
   *  external / video models), so no slider. */
  showStrength?: boolean;
}) {
  const { t } = useTranslation();
  const pair = slots >= 2;
  const current = Array.from({ length: slots }, (_, k) => images[k] ?? null);
  const filled = current.some(Boolean);
  const firstEmpty = current.findIndex((img) => !img);
  const inputRef = useRef<HTMLInputElement>(null);

  // Every image entering a slot is scaled to the model's working resolution
  // first: a raw phone photo is several MB of base64, and the extra pixels are
  // discarded by the engine anyway.
  const setSlot = async (i: number, value: string | null) => {
    const prepared = value ? await prepareRefImage(value, targetW, targetH) : null;
    const next = [...current];
    next[i] = prepared;
    onImagesChange(next);
  };

  // Header "Add": fills the first empty slot (the first frame on a pair).
  const addFromFile = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/") || firstEmpty === -1) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") void setSlot(firstEmpty, reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="ds-card px-4 py-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          addFromFile(e.target.files?.[0]);
          e.target.value = ""; // let the same file be re-picked later
        }}
      />
      <ComposerCardHeader
        title={pair ? t("refImage.titlePair") : t("refImage.title")}
        optionalLabel={t("refImage.optional")}
        help={pair ? t("refImage.hintPair") : t("refImage.hint")}
        action={
          <>
            {filled && (
              <button
                type="button"
                onClick={() => onImagesChange([])}
                className="text-muted-foreground/70 hover:text-foreground text-[11px]"
              >
                {t("common.clear")}
              </button>
            )}
            {firstEmpty !== -1 && (
              <AddButton label={t("refImage.add")} onClick={() => inputRef.current?.click()} />
            )}
          </>
        }
      />

      {/* Empty: the card is just its header (like the LoRA card); the image can
          also be dropped anywhere on the panel. */}
      {filled && (
        <div className="mt-3 flex items-start gap-3">
          <div className="flex gap-2">
            {current.map((img, i) => (
              <RefImageSlot
                key={i}
                image={img}
                onChange={(v) => void setSlot(i, v)}
                label={pair ? (i === 0 ? t("refImage.firstFrame") : t("refImage.lastFrame")) : ""}
              />
            ))}
          </div>

          {/* Strength only means something once there's an image to denoise from. */}
          {showStrength && (
          <label className="min-w-0 flex-1 pt-0.5">
            <HoverPopover content={t("refImage.strengthHint")} always className="inline-flex">
              <span className="text-muted-foreground cursor-help text-[11px]">
                {t("refImage.strength", { strength: strength.toFixed(2) })}
              </span>
            </HoverPopover>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={strength}
              onChange={(e) => onStrengthChange(Number(e.target.value))}
              className="range mt-1 w-full"
            />
          </label>
          )}
        </div>
      )}
    </section>
  );
}

// One square slot: click or drop to fill, hover to remove. Kept dumb (no
// knowledge of roles or counts) so the card owns all the layout decisions.
export function RefImageSlot({
  image,
  onChange,
  label,
}: {
  image: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const read = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          read(e.target.files?.[0]);
          e.target.value = ""; // let the same file be re-picked later
        }}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation(); // don't also trigger the panel-wide drop target
          setOver(false);
          read(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "group/slot relative size-16 shrink-0 overflow-hidden rounded-lg border transition-colors",
          image ? "border-border" : "border-primary/40 border-dashed",
          over && "border-primary bg-primary/5"
        )}
      >
        {image ? (
          <>
            <img src={image} alt={t("refImage.sourceAlt")} className="size-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label={t("common.remove")}
              title={t("common.remove")}
              className="bg-background/80 text-muted-foreground hover:text-destructive absolute right-1 top-1 rounded p-0.5 opacity-0 transition group-hover/slot:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-primary/80 hover:text-primary hover:bg-primary/10 bg-primary/5 flex size-full flex-col items-center justify-center gap-1 transition-colors"
          >
            <Plus className="size-4" strokeWidth={2.5} />
            <span className="text-[10px] font-medium leading-none">{t("refImage.add")}</span>
          </button>
        )}
      </div>
      {label && <span className="text-muted-foreground/70 text-[10px]">{label}</span>}
    </div>
  );
}
