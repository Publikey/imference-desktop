import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";

// ---------------------------------------------------------------------------
// CropFrame — the crop tool's mouse control: drag inside the frame to move it,
// drag a corner or an edge to resize it, pick a ratio to lock its shape. It
// edits the tool's x / y / width / height params (image pixels).
// ---------------------------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RATIOS = ["free", "1:1", "4:3", "3:2", "16:9", "9:16"] as const;
type Ratio = (typeof RATIOS)[number];
const MIN = 16;

function ratioOf(r: Ratio): number | null {
  if (r === "free") return null;
  const [a, b] = r.split(":").map(Number);
  return a / b;
}

/** The largest centered rectangle of ratio k inside w x h. */
function fit(k: number, w: number, h: number): Rect {
  let rw = w;
  let rh = Math.round(w / k);
  if (rh > h) {
    rh = h;
    rw = Math.round(h * k);
  }
  return { x: Math.round((w - rw) / 2), y: Math.round((h - rh) / 2), w: rw, h: rh };
}

export function CropFrame({
  src,
  params,
  onChange,
}: {
  src: string;
  params: Record<string, unknown>;
  onChange: (rect: { x: number; y: number; width: number; height: number }) => void;
}) {
  const { t } = useTranslation();
  const imgRef = useRef<HTMLImageElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [ratio, setRatio] = useState<Ratio>("free");
  const drag = useRef<{ handle: Handle; start: Rect; px: number; py: number; scale: number } | null>(null);

  const rect: Rect | null = dims
    ? {
        x: Number(params.x ?? 0),
        y: Number(params.y ?? 0),
        w: Number(params.width ?? dims.w - Number(params.x ?? 0)),
        h: Number(params.height ?? dims.h - Number(params.y ?? 0)),
      }
    : null;

  const emit = (r: Rect) =>
    onChange({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) });

  // Start on the whole image (no implicit crop).
  useEffect(() => {
    if (dims && params.width === undefined) emit({ x: 0, y: 0, w: dims.w, h: dims.h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims]);

  const pickRatio = (r: Ratio) => {
    setRatio(r);
    const k = ratioOf(r);
    if (dims && k) emit(fit(k, dims.w, dims.h));
  };

  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (!rect || !imgRef.current || !dims) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const scale = dims.w / imgRef.current.getBoundingClientRect().width;
    drag.current = { handle, start: rect, px: e.clientX, py: e.clientY, scale };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !dims) return;
    const dx = (e.clientX - d.px) * d.scale;
    const dy = (e.clientY - d.py) * d.scale;
    const s = d.start;
    let { x, y, w, h } = s;
    if (d.handle === "move") {
      x = Math.min(Math.max(0, s.x + dx), dims.w - s.w);
      y = Math.min(Math.max(0, s.y + dy), dims.h - s.h);
      emit({ x, y, w, h });
      return;
    }
    const k = ratioOf(ratio);
    const hd = d.handle;
    if (hd.includes("e")) w = Math.min(Math.max(MIN, s.w + dx), dims.w - s.x);
    if (hd.includes("s")) h = Math.min(Math.max(MIN, s.h + dy), dims.h - s.y);
    if (hd.includes("w")) {
      const nx = Math.min(Math.max(0, s.x + dx), s.x + s.w - MIN);
      w = s.w + (s.x - nx);
      x = nx;
    }
    if (hd.includes("n")) {
      const ny = Math.min(Math.max(0, s.y + dy), s.y + s.h - MIN);
      h = s.h + (s.y - ny);
      y = ny;
    }
    if (k) {
      // Locked ratio: the dragged side leads, the other follows, inside the image.
      if (hd === "n" || hd === "s") w = h * k;
      else h = w / k;
      if (x + w > dims.w) {
        w = dims.w - x;
        h = w / k;
      }
      if (y + h > dims.h) {
        h = dims.h - y;
        w = h * k;
      }
      if (hd.includes("n")) y = s.y + s.h - h;
      if (hd.includes("w")) x = s.x + s.w - w;
    }
    emit({ x, y, w, h });
  };
  const onUp = () => {
    drag.current = null;
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const handlePos: Record<string, string> = {
    nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
    ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
    se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
    s: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
    sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
    w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  };

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <Segmented<Ratio>
        size="sm"
        value={ratio}
        onChange={pickRatio}
        items={RATIOS.map((r) => ({ value: r, label: r === "free" ? t("tools.crop.free") : r }))}
      />
      <div className="relative w-fit max-w-full select-none" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="block max-h-[52vh] max-w-full rounded-lg"
        />
        {dims && rect && (
          <div
            className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
            style={{ left: pct(rect.x, dims.w), top: pct(rect.y, dims.h), width: pct(rect.w, dims.w), height: pct(rect.h, dims.h) }}
          >
            {/* Rule-of-thirds guides. */}
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="border border-white/25" />
              ))}
            </div>
            <div className="absolute inset-0 cursor-move" onPointerDown={onDown("move")} />
            {handles.map((h) => (
              <div
                key={h}
                onPointerDown={onDown(h)}
                className={cn(
                  "absolute size-3.5 rounded-sm border-2 border-white bg-black/60",
                  handlePos[h]
                )}
              />
            ))}
          </div>
        )}
      </div>
      {rect && (
        <p className="text-muted-foreground text-[11px] tabular-nums">
          {Math.round(rect.w)} × {Math.round(rect.h)} px
        </p>
      )}
    </div>
  );
}
