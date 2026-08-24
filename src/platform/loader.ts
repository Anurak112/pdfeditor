/**
 * Turning a picked File into something a tool can trust.
 *
 * The name and the browser-reported MIME type are both guesses — a file called
 * .pdf that is really a JPEG is the single most common bad input, and it fails
 * much later and much more confusingly if we believe the label. So the header
 * bytes decide, and everything else on LoadedFile is measured by opening the
 * document rather than inferred.
 */
import { getPdfjs } from '../lib/pdf/pdfjs';
import { appError } from '../engine/errors';
import type { AppError } from '../engine/errors';
import type { LoadedFile } from '../tools/types';
import { MAX_FILE_BYTES, MAX_PAGES_PER_FILE } from '../engine/limits';
import { MIME_FOR_KIND, sniff } from '../engine/sniff';

export { MIME_FOR_KIND, sniff };
export type { SniffedKind } from '../engine/sniff';

let seq = 0;

export interface LoadResult {
  file?: LoadedFile;
  error?: AppError;
}

function isPasswordError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  const msg = (e as { message?: string })?.message ?? '';
  return name === 'PasswordException' || /password/i.test(msg);
}

/**
 * Opens one file and measures it.
 *
 * An encrypted PDF is returned rather than rejected: it is a perfectly valid
 * input for the unlock tool, and the tools that cannot use it say so with their
 * own error and offer unlock as the way out.
 */
export async function loadFile(file: File): Promise<LoadResult> {
  if (file.size === 0) return { error: appError('E_EMPTY_FILE') };
  if (file.size > MAX_FILE_BYTES) {
    return {
      error: appError('E_TOO_LARGE', {
        hint: {
          th: `ไฟล์นี้ ${mb(file.size)} — รับได้ไม่เกิน ${mb(MAX_FILE_BYTES)}`,
          en: `This file is ${mb(file.size)} and the ceiling is ${mb(MAX_FILE_BYTES)}`,
        },
      }),
    };
  }
  return measureBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

/**
 * Measure bytes we produced ourselves.
 *
 * Chaining one tool's output into the next used to invent the metadata —
 * pageCount 0, no page sizes — which left the grid empty and the size estimate
 * wrong on a file the user had every reason to think was fully loaded. Output
 * gets measured exactly like input, because to everything downstream it is.
 */
export async function measureBytes(name: string, bytes: Uint8Array): Promise<LoadResult> {
  if (bytes.byteLength === 0) return { error: appError('E_EMPTY_FILE') };
  const file = { name, size: bytes.byteLength };
  const kind = sniff(bytes);

  if (kind === 'unknown') {
    return {
      error: appError('E_NOT_PDF', {
        detail: `magic bytes ${[...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' ')}`,
      }),
    };
  }

  const base: LoadedFile = {
    id: `f${++seq}`,
    name: file.name,
    bytes,
    sizeBytes: file.size,
    pageCount: 1,
    isEncrypted: false,
    hasTextLayer: false,
    pageSizes: [],
  };

  // An image is one page of itself once it is placed on a PDF page.
  if (kind === 'jpeg' || kind === 'png') return { file: base };

  // We keep the loading task, not just the document: destroy() lives on the
  // task, and it is the only thing that tears down the pdf.js worker. Probing
  // every dropped file and never releasing them leaks a worker per file.
  const task = getPdfjs().getDocument({ data: new Uint8Array(bytes) });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    if (isPasswordError(e)) {
      return { file: { ...base, pageCount: 0, isEncrypted: true } };
    }
    return { error: appError('E_CORRUPT', { detail: String((e as Error)?.message ?? e) }) };
  }

  try {
    const pageCount = doc.numPages;
    if (pageCount > MAX_PAGES_PER_FILE) {
      return {
        error: appError('E_TOO_MANY_PAGES', {
          hint: {
            th: `เอกสารนี้ ${pageCount} หน้า — รับได้ไม่เกิน ${MAX_PAGES_PER_FILE} หน้า`,
            en: `This document has ${pageCount} pages and the ceiling is ${MAX_PAGES_PER_FILE}`,
          },
        }),
      };
    }

    // Page sizes: read every page, but stop measuring after a sample on very
    // long documents — the only question we ask of them is "are they uniform?".
    const sampleTo = Math.min(pageCount, 25);
    const pageSizes: { w: number; h: number }[] = [];
    for (let p = 1; p <= sampleTo; p++) {
      const view = (await doc.getPage(p)).getViewport({ scale: 1 });
      pageSizes.push({ w: Math.round(view.width * 100) / 100, h: Math.round(view.height * 100) / 100 });
    }

    // Text layer: one page with real characters is enough to say yes. Checking
    // the first few pages rather than only page 1 avoids calling a scan out of a
    // document whose cover happens to be an image.
    let hasTextLayer = false;
    for (let p = 1; p <= Math.min(pageCount, 3) && !hasTextLayer; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      hasTextLayer = content.items.some((i) => {
        const str = (i as { str?: string }).str;
        return typeof str === 'string' && str.trim().length > 0;
      });
    }

    return { file: { ...base, pageCount, pageSizes, hasTextLayer } };
  } finally {
    // The tools re-open from `bytes` themselves, so nothing from this probe
    // should stay resident — release the document and its worker.
    void doc.cleanup();
    void task.destroy();
  }
}

/** Measures several byte buffers, keeping the good ones. */
export async function measureAll(items: { name: string; bytes: Uint8Array }[]): Promise<{ loaded: LoadedFile[]; errors: AppError[] }> {
  const loaded: LoadedFile[] = [];
  const errors: AppError[] = [];
  for (const item of items) {
    const r = await measureBytes(item.name, item.bytes);
    if (r.file) loaded.push(r.file);
    else if (r.error) errors.push(r.error);
  }
  return { loaded, errors };
}

/** Loads a batch, keeping the good ones and reporting the first failure. */
export async function loadFiles(files: File[]): Promise<{ loaded: LoadedFile[]; errors: AppError[] }> {
  const loaded: LoadedFile[] = [];
  const errors: AppError[] = [];
  for (const f of files) {
    const r = await loadFile(f);
    if (r.file) loaded.push(r.file);
    else if (r.error) errors.push(r.error);
  }
  return { loaded, errors };
}

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}
