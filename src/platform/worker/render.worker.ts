/**
 * Rasterising pages, off the main thread.
 *
 * Serves two callers with different needs from one open document: the grid
 * wants many small thumbnails and does not much care when they arrive, the
 * viewer wants one page at the current zoom and cares a great deal. Two workers
 * would mean two copies of the bytes, which for a 100MB file is the whole
 * problem — so they share this one, and requests carry a kind so the client can
 * put viewer work first.
 *
 * pdf.js still needs its own workerSrc even in here; leaving it unset does not
 * fall back to running inline, it throws. This reuses the editor's blob-URL
 * bootstrap, tries a nested worker, and lands on pdf.js's inline path — which
 * puts rasterising two threads away from the UI.
 */
import { getPdfjs } from '../../lib/pdf/pdfjs';
import { workerDocumentOptions } from '../../lib/pdf/workerDocument';
import { readAllPages } from '../../lib/editor/replaceJob';
import { countMatches } from '../../engine/operations/edit';
import type { PageText } from '../../lib/pdf/textExtract';
import type * as pdfjsLib from 'pdfjs-dist';

interface BaseRequest {
  jobId: string;
  /** A copy — this worker owns it and the caller keeps its own. */
  bytes: Uint8Array;
}

export interface ThumbsRequest extends BaseRequest {
  kind: 'thumbs';
  /** 0-based page indices, in the order they should appear. */
  indices: number[];
  /** Longest edge of the produced image, in device pixels. */
  maxEdge: number;
}

export interface PageRequest extends BaseRequest {
  kind: 'page';
  index: number;
  /** Width to draw at, in device pixels. Height follows the page's own ratio. */
  targetWidth: number;
  /** Lets the client drop a render that a newer zoom has already superseded. */
  token: number;
}

export interface FindRequest extends BaseRequest {
  kind: 'find';
  needle: string;
  /** Lets the client ignore a count a newer keystroke has already replaced. */
  token: number;
}

export type RenderRequest = ThumbsRequest | PageRequest | FindRequest;

export type RenderResponse =
  | { jobId: string; kind: 'thumb'; index: number; blob: Blob; width: number; height: number; rotation: number }
  | { jobId: string; kind: 'page'; index: number; token: number; blob: Blob; width: number; height: number }
  | { jobId: string; kind: 'found'; token: number; total: number; pages: number[]; scanned: boolean }
  | { jobId: string; kind: 'done'; of: 'thumbs' | 'page' | 'find' }
  | { jobId: string; kind: 'error'; of: 'thumbs' | 'page' | 'find'; message: string };

function post(message: RenderResponse) {
  (self as unknown as Worker).postMessage(message);
}

/** Documents stay open between requests: reopening to draw ten more pages is the slow way. */
let openFor: {
  key: string;
  doc: pdfjsLib.PDFDocumentProxy;
  task: pdfjsLib.PDFDocumentLoadingTask;
} | null = null;

/**
 * Extracted text, kept alongside the open document.
 *
 * Reading the text layer of a 900-page file takes seconds, and Edit asks for a
 * match count on every keystroke. Doing it once per document is the difference
 * between a live count and an unusable one.
 */
let textFor: { key: string; pages: PageText[] } | null = null;

async function docFor(jobId: string, bytes: Uint8Array) {
  if (openFor?.key === jobId) return openFor.doc;
  if (openFor) {
    void openFor.doc.cleanup();
    void openFor.task.destroy();
    openFor = null;
    textFor = null;
  }
  const task = getPdfjs().getDocument(workerDocumentOptions(bytes));
  const doc = await task.promise;
  openFor = { key: jobId, doc, task };
  return doc;
}

async function draw(
  doc: pdfjsLib.PDFDocumentProxy,
  index: number,
  scaleFor: (naturalWidth: number, naturalHeight: number) => number,
  quality: number,
) {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  // Guard the scale: a zoom slider bug asking for 40000px would allocate a
  // canvas big enough to take the tab down with it.
  const scale = Math.max(0.02, Math.min(8, scaleFor(base.width, base.height)));
  const viewport = page.getViewport({ scale });

  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas gave no 2d context');

  // Pages are transparent by default; without this, dark theme shows the page
  // content floating on nothing instead of on paper.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
  page.cleanup();

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, width: base.width, height: base.height, rotation: page.rotate ?? 0 };
}

self.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const request = event.data;
  const { jobId, bytes } = request;

  try {
    const doc = await docFor(jobId, bytes);

    if (request.kind === 'find') {
      if (!textFor || textFor.key === undefined || textFor.key !== jobId) {
        textFor = { key: jobId, pages: await readAllPages(doc) };
      }
      const { total, pages } = countMatches(textFor.pages, request.needle);
      post({
        jobId,
        kind: 'found',
        token: request.token,
        total,
        pages,
        scanned: textFor.pages.every((p) => p.items.length === 0),
      });
      post({ jobId, kind: 'done', of: 'find' });
      return;
    }

    if (request.kind === 'page') {
      const { index, targetWidth, token } = request;
      if (index < 0 || index >= doc.numPages) {
        post({ jobId, kind: 'error', of: 'page', message: `page ${index + 1} is outside this document` });
        return;
      }
      // A page being looked at earns a better JPEG than a thumbnail does.
      const drawn = await draw(doc, index, (w) => targetWidth / w, 0.9);
      post({ jobId, kind: 'page', index, token, blob: drawn.blob, width: drawn.width, height: drawn.height });
      post({ jobId, kind: 'done', of: 'page' });
      return;
    }

    // Thumbnails are posted one at a time rather than batched at the end: a
    // grid that fills in from the top reads as fast, and one that appears all
    // at once after two seconds reads as broken.
    for (const index of request.indices) {
      if (index < 0 || index >= doc.numPages) continue;
      const drawn = await draw(doc, index, (w, h) => request.maxEdge / Math.max(w, h), 0.72);
      post({ jobId, kind: 'thumb', index, ...drawn });
    }
    post({ jobId, kind: 'done', of: 'thumbs' });
  } catch (e) {
    post({
      jobId,
      kind: 'error',
      of: request.kind === 'page' ? 'page' : request.kind === 'find' ? 'find' : 'thumbs',
      message: String((e as Error)?.message ?? e),
    });
  }
};
