/**
 * Where the PDF work happens.
 *
 * Everything runs here, with no exceptions, because a 200-page document on the
 * main thread freezes the tab — and a frozen tab gets reloaded, which loses the
 * work entirely.
 *
 * There is no dispatch table left in this file. It hands the job to the engine
 * and reports what comes back, so adding an operation never touches worker
 * plumbing again.
 */
import { getPdfjs } from '../../lib/pdf/pdfjs';
import { recodeImage } from '../imageCodec';
import { runJob } from '../../engine/job';
import type { JobProgress, PdfJob } from '../../engine/job';
import type { AppError } from '../../engine/errors';
import type { JobFile, OperationId, OperationResult } from '../../engine/types';

export interface WorkerRequest {
  jobId: string;
  operation: OperationId;
  /** A copy — this worker owns it and the caller keeps its own. */
  files: JobFile[];
  options: unknown;
}

/** Sent when the user cancels, ahead of the terminate that guarantees it. */
export interface WorkerCancel {
  jobId: string;
  kind: 'cancel';
}

export type WorkerInbound = WorkerRequest | WorkerCancel;

export type WorkerResponse =
  | { jobId: string; kind: 'progress'; progress: JobProgress }
  | { jobId: string; kind: 'done'; result: OperationResult; warnings: AppError[]; durationMs: number }
  | { jobId: string; kind: 'error'; error: AppError };

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

/**
 * Set by a cancel message and read between operation steps.
 *
 * The caller also terminates this worker, which is what actually guarantees the
 * work stops — a message cannot interrupt a synchronous pdf-lib loop. This flag
 * covers the gap the terminate leaves: it lets the operation unwind at its next
 * step instead of dying mid-write, and it stops a `done` message that was
 * already queued from racing the terminate and resolving a cancelled run.
 */
let cancelled = false;

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  if ('kind' in event.data && event.data.kind === 'cancel') {
    cancelled = true;
    return;
  }

  const { jobId, operation, files, options } = event.data as WorkerRequest;
  cancelled = false;

  const job: PdfJob = {
    id: jobId,
    operation,
    files,
    options,
    state: 'created',
    progress: null,
    result: null,
    warnings: [],
    error: null,
    startedAt: null,
    finishedAt: null,
  };

  const finished = await runJob(job, {
    // How this host loads pdf.js. A Node test hands in the legacy build
    // instead, which is why the operation does not reach for one itself.
    openPdfjs: async (bytes) => {
      const task = getPdfjs().getDocument({
      data: new Uint8Array(bytes),
      // A worker has no document.fonts, which is how pdf.js normally installs
      // an embedded font before drawing with it. Without this it silently
      // falls back to .notdef and every Thai glyph comes out as a box, while
      // Latin survives on the standard fonts — so the failure looks like a
      // font problem in the document rather than in us. True makes pdf.js
      // draw the glyph outlines directly, which needs no DOM.
      disableFontFace: true,
    });
      const doc = await task.promise;
      return {
        doc,
        close: () => {
          void doc.cleanup();
          void task.destroy();
        },
      };
    },
    // And how it re-encodes an image. Same arrangement, same reason: the
    // engine decides which images and at what size, the host owns the codec.
    recodeImage,
    onProgress: (progress) => {
      if (!cancelled) post({ jobId, kind: 'progress', progress });
    },
    isAborted: () => cancelled,
  });

  if (cancelled) return;

  if (finished.state === 'done' && finished.result) {
    // The outputs are ours to give away — nothing here keeps a reference, so
    // transferring avoids a second copy of every result.
    post(
      {
        jobId,
        kind: 'done',
        result: finished.result,
        warnings: finished.warnings,
        durationMs: (finished.finishedAt ?? 0) - (finished.startedAt ?? 0),
      },
      finished.result.files.map((f) => f.bytes.buffer as ArrayBuffer),
    );
    return;
  }

  post({
    jobId,
    kind: 'error',
    error: finished.error ?? {
      code: 'E_INTERNAL',
      severity: 'error',
      message: { th: 'งานจบลงโดยไม่มีผลลัพธ์', en: 'The job ended without producing anything' },
      actions: [],
    },
  });
};
