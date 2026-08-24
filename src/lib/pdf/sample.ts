/**
 * Reading colours off a rasterised page.
 *
 * Split out of render.ts so it can run in a worker: the rendering half needs a
 * DOM canvas, this half needs only something with getImageData — and an
 * OffscreenCanvas has that. The overlay fallback has to paint a patch over old
 * text, and guessing white is what makes those edits look like stickers.
 */

/** Anything that can hand back pixels. A DOM canvas and an OffscreenCanvas both can. */
export interface SamplableCanvas {
  width: number;
  height: number;
  getContext(
    contextId: '2d',
    options?: { willReadFrequently?: boolean },
  ): { getImageData(x: number, y: number, w: number, h: number): ImageData } | null;
}

export interface SampleTarget {
  canvas: SamplableCanvas;
  scale: number;
  /** Page height in PDF user space, for flipping y. */
  height: number;
}

export interface RGB { r: number; g: number; b: number }

export interface SampledColors {
  /** Dominant colour of the area — what to paint the patch with. */
  background: RGB;
  /** Colour furthest from the background — the ink. */
  text: RGB;
  /** False when the area was flat (no text found), so `text` is a guess. */
  foundInk: boolean;
}

/**
 * Sample an area given in PDF user space (y up) off an already-rendered page.
 */
export function sampleColors(rendered: SampleTarget, rect: { x: number; y: number; width: number; height: number }): SampledColors {
  const fallback: SampledColors = { background: { r: 1, g: 1, b: 1 }, text: { r: 0, g: 0, b: 0 }, foundInk: false };
  const ctx = rendered.canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return fallback;

  const s = rendered.scale;
  const pad = 2;
  const left = Math.max(0, Math.floor(rect.x * s) - pad);
  const top = Math.max(0, Math.floor((rendered.height - rect.y - rect.height) * s) - pad);
  const w = Math.min(rendered.canvas.width - left, Math.ceil(rect.width * s) + pad * 2);
  const h = Math.min(rendered.canvas.height - top, Math.ceil(rect.height * s) + pad * 2);
  if (w <= 0 || h <= 0) return fallback;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(left, top, w, h).data;
  } catch {
    return fallback;
  }

  // quantise to 5 bits per channel and take the mode as the background
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bgKey = -1;
  let bgCount = -1;
  for (const [key, count] of counts) if (count > bgCount) { bgCount = count; bgKey = key; }
  const bg = {
    r: (((bgKey >> 10) & 31) * 255) / 31 / 255,
    g: (((bgKey >> 5) & 31) * 255) / 31 / 255,
    b: ((bgKey & 31) * 255) / 31 / 255,
  };

  // ink = the colour furthest from the background that still covers real area
  const minPixels = Math.max(3, Math.floor((w * h) / 400));
  let ink = { ...bg };
  let bestDistance = 0;
  for (const [key, count] of counts) {
    if (count < minPixels || key === bgKey) continue;
    const c = {
      r: (((key >> 10) & 31) * 255) / 31 / 255,
      g: (((key >> 5) & 31) * 255) / 31 / 255,
      b: ((key & 31) * 255) / 31 / 255,
    };
    const d = Math.hypot(c.r - bg.r, c.g - bg.g, c.b - bg.b);
    if (d > bestDistance) { bestDistance = d; ink = c; }
  }

  return { background: bg, text: bestDistance > 0.15 ? ink : { r: 0, g: 0, b: 0 }, foundInk: bestDistance > 0.15 };
}
