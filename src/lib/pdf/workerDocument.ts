/**
 * How pdf.js has to be asked to open a document when there is no DOM.
 *
 * Its own file, with no imports, for one reason: `pdfjs.ts` pulls in the worker
 * source through a bundler-only `?raw` import, which puts everything in it out
 * of reach of a Node test. These two corrections are the ones most worth being
 * able to check, so they live where a test can see them.
 */

/**
 * Canvases for a place with no document.
 *
 * pdf.js draws most pages straight onto the canvas it was handed, but some need
 * a scratch one — a transparency group, a soft mask, a tiling pattern, a Type 3
 * font. It asks its canvas factory for that, and the factory it picks by
 * default does `globalThis.document.createElement('canvas')`. In a worker there
 * is no document, so rendering failed with "Cannot read properties of undefined
 * (reading 'createElement')" — but only on the documents that happen to need a
 * scratch canvas, which is why it looked like certain files were broken rather
 * than certain features. An invoice with a logo hit it; a page of plain text
 * did not.
 */
export class OffscreenCanvasFactory {
  readonly #hardware: boolean;

  constructor(options: { enableHWA?: boolean } = {}) {
    this.#hardware = options.enableHWA ?? false;
  }

  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext('2d', { willReadFrequently: !this.#hardware }),
    };
  }

  reset(target: { canvas: OffscreenCanvas | null }, width: number, height: number) {
    if (!target.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (!target.canvas) throw new Error('Canvas is not specified');
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

/**
 * The options both workers open documents with.
 *
 * One place on purpose. They used to hold a copy each: the font correction was
 * applied to both by hand, and the canvas one was missing from both — two files
 * that were each individually valid and together wrong.
 */
export function workerDocumentOptions(bytes: Uint8Array) {
  return {
    // pdf.js takes ownership of the buffer it is given, so always hand it a copy.
    data: new Uint8Array(bytes),
    // A worker has no document.fonts, which is how pdf.js normally installs an
    // embedded font before drawing with it. Without this it silently falls back
    // to .notdef and every Thai glyph comes out as a box, while Latin survives
    // on the standard fonts — so the failure looks like a font problem in the
    // document rather than in us. True makes pdf.js draw the glyph outlines
    // directly, which needs no DOM.
    disableFontFace: true,
    CanvasFactory: OffscreenCanvasFactory,
  };
}
