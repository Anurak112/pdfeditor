/**
 * Handing a job to the worker, and getting it back.
 *
 * One worker per run, terminated when the run ends. A pool would save the
 * startup cost, but termination is the only way to actually stop a synchronous
 * pdf-lib loop mid-flight — and a cancel button that does not cancel is worse
 * than a slightly slower start.
 */
import { appError, toAppError } from '../../engine/errors';
import type { AppError } from '../../engine/errors';
import type { JobFile, OperationId, OperationResult } from '../../engine/types';
import type { WorkerRequest, WorkerResponse } from './pdf.worker';

export interface WorkerRunOptions {
  onProgress(percent: number, message: { th: string; en: string }): void;
  signal: AbortSignal;
}

export interface WorkerOutcome {
  result: OperationResult;
  warnings: AppError[];
  durationMs: number;
}

let seq = 0;

export function runInWorker(
  operation: OperationId,
  files: JobFile[],
  options: unknown,
  opts: WorkerRunOptions,
): Promise<WorkerOutcome> {
  return new Promise<WorkerOutcome>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(appError('E_CANCELLED'));
      return;
    }

    const jobId = `w${++seq}`;
    const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };

    function onAbort() {
      // Tell it first, then kill it. The message lets the operation unwind
      // cleanly if it happens to be between steps; the terminate is what
      // guarantees the work stops if it is not.
      try {
        worker.postMessage({ jobId, kind: 'cancel' });
      } catch {
        /* already gone — the terminate below covers it */
      }
      finish(() => reject(appError('E_CANCELLED')));
    }
    opts.signal.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.jobId !== jobId) return;

      if (msg.kind === 'progress') {
        opts.onProgress(msg.progress.percent, msg.progress.message);
        return;
      }
      if (msg.kind === 'error') {
        finish(() => reject(msg.error));
        return;
      }
      finish(() => resolve({ result: msg.result, warnings: msg.warnings, durationMs: msg.durationMs }));
    };

    worker.onerror = (event) => {
      finish(() => reject(toAppError(new Error(event.message || 'the worker stopped unexpectedly'))));
    };

    // Copy the bytes rather than transferring them. Transferring detaches the
    // buffer on this side, which would empty the file list the moment a run
    // starts — the user would lose their input by pressing the button.
    const copied: JobFile[] = files.map((f) => ({
      id: f.id,
      name: f.name,
      bytes: new Uint8Array(f.bytes),
    }));

    const request: WorkerRequest = { jobId, operation, files: copied, options };
    worker.postMessage(request);
  });
}
