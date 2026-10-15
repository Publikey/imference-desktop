// Display names of the local engine backends (BackendType, normalized by the Go
// side's cloud.normalizeEngine). Proper nouns: not translated.
export const ENGINE_LABEL: Record<string, string> = {
  sdxl: "SDXL",
  sd15: "SD 1.5",
  zimage: "Z-Image",
  flux: "FLUX",
  chroma: "Chroma",
  qwenimage: "Qwen-Image",
  // Instruction editing only (Edit > Edit with instructions), no text-to-image.
  "qwenimage-edit": "Qwen-Image-Edit",
  anima: "Anima",
  krea2: "Krea 2",
  wan: "WAN Video",
};

/** The scroll container an element scrolls in: its panel column on the
 *  desktop layout (each column scrolls on its own), else null (the viewport). */
export function scrollRootOf(el: Element | null): Element | null {
  const root = el?.closest("[data-scroll-root]") ?? null;
  if (!root) return null;
  const oy = getComputedStyle(root).overflowY;
  return oy === "auto" || oy === "scroll" ? root : null;
}
