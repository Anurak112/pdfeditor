/**
 * pdf.js bootstrap.
 *
 * The worker is imported as source text and handed to pdf.js as a blob URL, so
 * one built HTML file stays self-contained — it works from a dev server, from
 * a static host, and from a plain file:// double-click. If the browser refuses
 * a blob worker (file:// is the usual culprit) pdf.js falls back to running on
 * the main thread, which is fine for the one-page documents this tool targets.
 */
import * as pdfjsLib from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

let ready = false;

export function getPdfjs(): typeof pdfjsLib {
  if (!ready) {
    try {
      const blob = new Blob([workerSource], { type: 'text/javascript' });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch {
      /* leave workerSrc unset — pdf.js will use its fake-worker path */
    }
    ready = true;
  }
  return pdfjsLib;
}

export type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;

/** pdf.js takes ownership of the buffer it is given, so always hand it a copy. */
export async function loadPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = getPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
}
