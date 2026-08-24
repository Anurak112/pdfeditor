/**
 * Page rasterising + colour sampling.
 *
 * The overlay fallback has to paint a patch over the old text, so it needs to
 * know what colour that corner of the page actually is. Guessing white is what
 * makes overlay edits look like stickers; sampling the rendered pixels keeps
 * the patch invisible on tinted panels and coloured cards.
 */
import type { PdfDocument } from './pdfjs';

export interface RenderedPage {
  canvas: HTMLCanvasElement;
  scale: number;
  /** Page size in PDF user space. */
  width: number;
  height: number;
}

export async function renderPage(doc: PdfDocument, pageNumber: number, scale: number): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('ไม่สามารถสร้าง canvas ได้');
  await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
  const base = page.getViewport({ scale: 1 });
  return { canvas, scale, width: base.width, height: base.height };
}

export { sampleColors } from './sample';
export type { RGB, SampledColors, SampleTarget, SamplableCanvas } from './sample';
