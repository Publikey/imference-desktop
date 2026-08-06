// Client-side preparation of reference images before they leave the machine.
//
// The picker used to hand the raw file straight through: a 12 MP phone photo
// became 5–11 MB of base64 in the generate request. A reference image only ever
// needs the model's working resolution, so scaling it down here cuts the
// payload by an order of magnitude — bandwidth, server memory, and the
// buffered-before-payment window on the x402 rail all shrink with it.
//
// The server re-clamps regardless: this is an optimisation, not a control.

/** JPEG quality for prepared reference images — visually lossless at this size. */
const DEFAULT_QUALITY = 0.9;

/**
 * Scale `src` to fit within targetW×targetH and re-encode as JPEG.
 *
 * Aspect ratio is preserved and the image is never upscaled: in img2img the
 * engine derives the output size from the source, so cropping would silently
 * change the framing the user chose, and enlarging would add bytes without
 * adding information.
 *
 * Returns a `data:image/jpeg;base64,…` URL. Falls back to the original string
 * if the image can't be decoded (an exotic format the canvas refuses) — the
 * server still validates, so a passthrough is safe.
 */
export async function prepareRefImage(
  src: string,
  targetW: number,
  targetH: number,
  quality: number = DEFAULT_QUALITY
): Promise<string> {
  try {
    const img = await loadImage(src);
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, targetW, targetH);

    // Already at or below the target and already JPEG: nothing to gain.
    if (width === img.naturalWidth && height === img.naturalHeight && src.startsWith("data:image/jpeg")) {
      return src;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    // A white backdrop, because JPEG has no alpha: without it a transparent PNG
    // would flatten onto black and come back as a very different picture.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return src;
  }
}

/** Largest width×height that fits in the target box, never enlarging. */
export function fitWithin(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number
): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0 || targetW <= 0 || targetH <= 0) {
    return { width: srcW, height: srcH };
  }
  const scale = Math.min(targetW / srcW, targetH / srcH, 1);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("cannot decode image"));
    img.src = src;
  });
}
