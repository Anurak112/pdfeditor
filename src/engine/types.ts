/**
 * The engine's vocabulary.
 *
 * Everything under `engine/` is worker-safe: no Svelte, no DOM, no knowledge of
 * routes or panels. The dependency only ever points one way — the UI knows
 * about the engine, the engine knows nothing about the UI. That is what lets an
 * operation run in a worker, on the main thread, or in a Node test unchanged.
 */
import type { AppError } from './errors';
// Type-only: pdfjs.ts pulls in worker source that only a bundler can resolve,
// so importing its value would put the engine out of reach of a Node test.
import type { PdfDocument } from '../lib/pdf/pdfjs';

export interface LocalizedString {
  th: string;
  en: string;
}

export type OperationId = 'merge' | 'split' | 'compress' | 'convert' | 'edit' | 'organize' | 'unlock';

/** An input as the engine sees it: bytes and a name, nothing browser-shaped. */
export interface JobFile {
  id: string;
  name: string;
  bytes: Uint8Array;
}

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface RunStats {
  originalBytes?: number;
  outputBytes?: number;
  savedPercent?: number;
  pagesProcessed?: number;
  replacements?: number;
}

/**
 * An open pdf.js document plus the way to let it go.
 *
 * Operations that need to read text or draw pixels cannot open it themselves:
 * both need pdf.js, and how pdf.js is loaded differs by host — a bundler build
 * in the app, the legacy build in a Node test. So the host hands the opener in,
 * the same reason replaceInDocument has always taken a document rather than
 * bytes.
 */
export interface OpenedPdfjs {
  doc: PdfDocument;
  close(): void;
}

export type PdfjsOpener = (bytes: Uint8Array) => Promise<OpenedPdfjs>;

/**
 * An image on its way to the host's encoder.
 *
 * Compress cannot encode anything itself: producing JPEG bytes needs a canvas,
 * and the engine deliberately has no DOM. So the pixels go out and come back,
 * the same arrangement pdf.js arrives under, and for the same reason — it keeps
 * the operation testable somewhere with neither.
 */
export interface ImageToRecode {
  source:
    | { kind: 'jpeg'; bytes: Uint8Array }
    | { kind: 'samples'; bytes: Uint8Array; components: 1 | 3 };
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  /** 0 to 1. Ignored by an encoder that answers with flate. */
  quality: number;
}

/**
 * What comes back.
 *
 * Flate is here beside JPEG because JPEG is the wrong answer often enough to
 * matter: it puts ringing around the edges of line art and it cannot carry the
 * clean gradient of a soft mask. An encoder that can tell the difference should
 * be allowed to say so.
 */
export type RecodedImage =
  | { format: 'jpeg'; bytes: Uint8Array; width: number; height: number; components: 1 | 3 }
  | { format: 'flate'; bytes: Uint8Array; width: number; height: number; components: 1 | 3 };

/** Returns null when it cannot encode this one — never a throw, never a guess. */
export type ImageRecoder = (image: ImageToRecode) => Promise<RecodedImage | null>;

export interface OperationContext {
  /** Percent must come from work actually finished, never from a timer. */
  onProgress(percent: number, message: LocalizedString): void;
  /** Called between steps so a cancelled run unwinds instead of finishing. */
  throwIfAborted(): void;
  /**
   * Something worth saying while the work still succeeds.
   *
   * On the context rather than returned, because every operation was otherwise
   * going to declare its own array and remember to hand it back — and the one
   * that forgets loses the warning silently.
   */
  warn(warning: AppError): void;
  /** Present only for hosts that can load pdf.js. Absent for operations that never need it. */
  openPdfjs?: PdfjsOpener;
  /** Present only for hosts with a canvas. Compress does nothing to images without it. */
  recodeImage?: ImageRecoder;
}

export interface OperationResult {
  files: OutputFile[];
  stats?: RunStats;
}

/**
 * One thing the engine can do.
 *
 * Operations do not open their own inputs blindly — `document.ts` does that,
 * so error messages, page-range parsing and encryption handling read the same
 * whichever tool the user picked.
 */
export interface PdfOperation<O = unknown> {
  id: OperationId;
  run(files: JobFile[], options: O, ctx: OperationContext): Promise<OperationResult>;
}

/**
 * Maps "3 of 8 done" onto a slice of the overall bar.
 *
 * Every operation was reaching for the same `Math.round((i / n) * 40)`, and
 * getting the arithmetic subtly different each time.
 */
export function span(from: number, to: number) {
  return (done: number, total: number) => from + Math.round((done / Math.max(1, total)) * (to - from));
}
