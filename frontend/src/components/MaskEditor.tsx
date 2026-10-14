// MaskEditor — paint (or click-to-select) the area a tool should change, on top
// of the image. Used by the magic eraser and inpaint.
//
// The visible <canvas> IS the mask, at the image's natural resolution (CSS
// scales it over the <img>): painted pixels are opaque brand color, shown at
// half opacity. exportMask() flattens it to the PNG the engine expects —
// white = selected, black elsewhere, exactly the image's size.
//
// Click-to-select calls the "segment" tool (MobileSAM) with the click and ADDS
// the returned mask to the painted one (Shift/Alt-click subtracts), so
// select -> erase / repaint never leaves the image.
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brush, Loader2, MousePointerClick, Trash2, Undo2 } from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { loadImage, newToolJobId } from "@/lib/tools";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import type { ToolError, ToolsMode } from "@/lib/types";

export type MaskEditorHandle = {
  /** The mask as a PNG data URL (white = selected), or null when empty. */
  exportMask: () => string | null;
  isEmpty: () => boolean;
  clear: () => void;
};

// "eraser" is kept for callers' compatibility and behaves as "brush": the
// brush erases with the right button or Shift held.
export type MaskMode = "brush" | "eraser" | "select";

const MASK_RGB: [number, number, number] = [236, 72, 153]; // brand pink
const UNDO_MAX = 8;

export function MaskEditor({
  src,
  ref,
  sourceInput,
  initialMode = "brush",
  selectRunOn,
  onChange,
  onSelectError,
  disabled,
}: {
  /** The image (data URL) being masked. */
  src: string;
  ref?: React.Ref<MaskEditorHandle>;
  /** What to send the segment tool as its image input (gallery name or data URL). */
  sourceInput: string;
  initialMode?: MaskMode;
  /** Where click-to-select runs (the dialog's run-on choice). */
  selectRunOn: ToolsMode | "";
  /** Fired after every edit with whether anything is selected. */
  onChange?: (hasMask: boolean) => void;
  onSelectError?: (e: ToolError) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<MaskMode>(initialMode === "eraser" ? "brush" : initialMode);
  // Shift held while hovering: the brush ring shows it would erase.
  const [shiftHeld, setShiftHeld] = useState(false);
  const [brush, setBrush] = useState(24);
  const [selecting, setSelecting] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; d: number } | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const drawingRef = useRef<{ x: number; y: number } | null>(null);
  // The current stroke erases (right button or Shift) instead of painting.
  const erasingRef = useRef(false);
  const [erasing, setErasing] = useState(false);

  // Natural size of the image -> the mask's resolution.
  useEffect(() => {
    let alive = true;
    void loadImage(src)
      .then((img) => {
        if (!alive) return;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        setSize({ w, h });
        setBrush(Math.max(8, Math.round(Math.max(w, h) / 40)));
        undoRef.current = [];
        setUndoCount(0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src]);

  const ctx = () => canvasRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;

  const hasMask = useCallback((): boolean => {
    const c = canvasRef.current;
    const g = ctx();
    if (!c || !g || !c.width) return false;
    const data = g.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 16) if (data[i] > 0) return true;
    return false;
  }, []);

  const changed = useCallback(() => onChange?.(hasMask()), [onChange, hasMask]);

  const snapshot = () => {
    const c = canvasRef.current;
    const g = ctx();
    if (!c || !g) return;
    undoRef.current.push(g.getImageData(0, 0, c.width, c.height));
    if (undoRef.current.length > UNDO_MAX) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
  };

  const undo = () => {
    const g = ctx();
    const prev = undoRef.current.pop();
    setUndoCount(undoRef.current.length);
    if (g && prev) {
      g.putImageData(prev, 0, 0);
      changed();
    }
  };

  const clear = useCallback(() => {
    const c = canvasRef.current;
    const g = ctx();
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    changed();
  }, [changed]);

  useImperativeHandle(
    ref,
    () => ({
      isEmpty: () => !hasMask(),
      clear,
      exportMask: () => {
        const c = canvasRef.current;
        if (!c || !hasMask()) return null;
        const out = document.createElement("canvas");
        out.width = c.width;
        out.height = c.height;
        const o = out.getContext("2d");
        if (!o) return null;
        o.drawImage(c, 0, 0);
        o.globalCompositeOperation = "source-in"; // painted pixels -> white
        o.fillStyle = "#fff";
        o.fillRect(0, 0, out.width, out.height);
        o.globalCompositeOperation = "destination-over"; // the rest -> black
        o.fillStyle = "#000";
        o.fillRect(0, 0, out.width, out.height);
        return out.toDataURL("image/png");
      },
    }),
    [hasMask, clear]
  );

  // Pointer position in mask (natural) pixels.
  const toMask = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
      scale: r.width / c.width,
    };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const g = ctx();
    if (!g) return;
    g.globalCompositeOperation = erasingRef.current ? "destination-out" : "source-over";
    g.strokeStyle = `rgb(${MASK_RGB.join(",")})`;
    g.fillStyle = g.strokeStyle;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.lineWidth = brush;
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke();
  };

  const selectAt = async (x: number, y: number, subtract: boolean) => {
    setSelecting(true);
    try {
      const res = await api.runTool({
        jobId: newToolJobId(),
        toolId: "segment",
        inputs: { image: [sourceInput] },
        params: { points: [{ x: Math.round(x), y: Math.round(y), label: 1 }], dilate: 4 },
        runOn: selectRunOn,
        noSave: true,
      });
      if (res.error) {
        onSelectError?.(res.error);
        return;
      }
      const mask = res.outputs.find((o) => o.dataUrl);
      if (!mask?.dataUrl) return;
      const img = await loadImage(mask.dataUrl);
      const c = canvasRef.current;
      const g = ctx();
      if (!c || !g) return;
      // Grayscale mask -> brand-colored alpha, at the canvas size.
      const tmp = document.createElement("canvas");
      tmp.width = c.width;
      tmp.height = c.height;
      const tg = tmp.getContext("2d", { willReadFrequently: true })!;
      tg.drawImage(img, 0, 0, c.width, c.height);
      const id = tg.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i];
        d[i] = MASK_RGB[0];
        d[i + 1] = MASK_RGB[1];
        d[i + 2] = MASK_RGB[2];
        d[i + 3] = a;
      }
      tg.putImageData(id, 0, 0);
      snapshot();
      g.globalCompositeOperation = subtract ? "destination-out" : "source-over";
      g.drawImage(tmp, 0, 0);
      changed();
    } catch (e) {
      onSelectError?.({ code: "internal", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSelecting(false);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || !size) return;
    const p = toMask(e);
    const subtract = e.button === 2 || e.shiftKey || e.altKey;
    if (mode === "select") {
      if (!selecting) void selectAt(p.x, p.y, subtract);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    erasingRef.current = subtract;
    setErasing(subtract);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    snapshot();
    drawingRef.current = p;
    stroke(p, p);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!size) return;
    const p = toMask(e);
    setShiftHeld(e.shiftKey || e.altKey);
    const r = canvasRef.current!.getBoundingClientRect();
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top, d: brush * p.scale });
    if (drawingRef.current) {
      stroke(drawingRef.current, p);
      drawingRef.current = p;
    }
  };
  const onPointerUp = () => {
    if (drawingRef.current) {
      drawingRef.current = null;
      erasingRef.current = false;
      setErasing(false);
      changed();
    }
  };

  const maxBrush = size ? Math.max(16, Math.round(Math.max(size.w, size.h) / 4)) : 200;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<MaskMode>
          size="sm"
          value={mode}
          onChange={setMode}
          items={[
            { value: "brush", label: t("tools.mask.brush"), icon: <Brush className="size-3.5" /> },
            { value: "select", label: t("tools.mask.select"), icon: <MousePointerClick className="size-3.5" /> },
          ]}
        />
        {mode !== "select" && (
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            {t("tools.mask.size")}
            <input
              type="range"
              min={2}
              max={maxBrush}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
              className="w-28 accent-[var(--brand-to)]"
            />
            <span className="w-8 tabular-nums">{brush}</span>
          </label>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={undo}
            disabled={undoCount === 0 || disabled}
            className="hover:bg-muted rounded-md p-1.5 disabled:opacity-40"
            title={t("tools.mask.undo")}
            aria-label={t("tools.mask.undo")}
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              snapshot();
              clear();
            }}
            disabled={disabled}
            className="hover:bg-muted rounded-md p-1.5 disabled:opacity-40"
            title={t("tools.mask.clear")}
            aria-label={t("tools.mask.clear")}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {t(mode === "select" ? "tools.mask.selectHint" : "tools.mask.brushHint")}
      </p>
      <div className="relative mx-auto w-fit max-w-full">
        <img src={src} alt="" draggable={false} className="block max-h-[52vh] max-w-full rounded-lg select-none" />
        {size && (
          <canvas
            ref={canvasRef}
            width={size.w}
            height={size.h}
            onPointerDown={onPointerDown}
            onContextMenu={(e) => e.preventDefault()}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              setCursor(null);
              onPointerUp();
            }}
            className={cn(
              "absolute inset-0 h-full w-full touch-none rounded-lg opacity-55",
              mode === "select" ? (selecting ? "cursor-progress" : "cursor-crosshair") : "cursor-none"
            )}
          />
        )}
        {cursor && mode !== "select" && (
          <div
            className={cn(
              "pointer-events-none absolute rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]",
              (erasing || shiftHeld) && "border-dashed"
            )}
            style={{ left: cursor.x - cursor.d / 2, top: cursor.y - cursor.d / 2, width: cursor.d, height: cursor.d }}
          />
        )}
        {selecting && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/25">
            <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white">
              <Loader2 className="size-3.5 animate-spin" /> {t("tools.mask.selecting")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
