/**
 * A unit of work, as a thing rather than as control flow.
 *
 * Before this, "the job" existed only as local variables inside a try/catch in
 * the session — which meant nothing else could see it. A job you can hold is a
 * job you can time, log, hand to a worker, hand back, and later queue or retry
 * without redesigning anything.
 *
 * Running one is also the single place that catches, times and collects
 * warnings, so no operation and no caller has to remember to.
 */
import { toAppError } from './errors';
import type { AppError } from './errors';
import { getOperation } from './operations';
import type {
  ImageRecoder,
  JobFile,
  LocalizedString,
  OperationContext,
  OperationId,
  OperationResult,
  PdfjsOpener,
} from './types';

export type JobState = 'created' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  percent: number;
  message: LocalizedString;
}

export interface PdfJob<O = unknown> {
  id: string;
  operation: OperationId;
  files: JobFile[];
  options: O;

  state: JobState;
  progress: JobProgress | null;
  result: OperationResult | null;
  /** Collected during the run; present even when the job succeeded. */
  warnings: AppError[];
  error: AppError | null;

  startedAt: number | null;
  finishedAt: number | null;
}

let seq = 0;

export function createJob<O>(operation: OperationId, files: JobFile[], options: O): PdfJob<O> {
  return {
    id: `job${++seq}`,
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
}

export interface RunHooks {
  onProgress?(progress: JobProgress): void;
  /** Return true once the run should stop. */
  isAborted?(): boolean;
  /** How this host loads pdf.js, for operations that read the text layer. */
  openPdfjs?: PdfjsOpener;
  /** How this host re-encodes an image, for Compress. */
  recodeImage?: ImageRecoder;
}

/**
 * Runs a job to completion and returns it, finished.
 *
 * Mutates the job it was given rather than cloning: the caller usually wants to
 * watch the same object it handed over, and a copy would just mean two versions
 * of the truth about one piece of work.
 */
export async function runJob<O>(job: PdfJob<O>, hooks: RunHooks = {}): Promise<PdfJob<O>> {
  const operation = getOperation(job.operation);
  if (!operation) {
    job.state = 'failed';
    job.error = toAppError(new Error(`no operation registered as "${job.operation}"`));
    return job;
  }

  job.state = 'running';
  job.startedAt = Date.now();
  job.warnings = [];
  job.error = null;
  job.result = null;

  const ctx: OperationContext = {
    onProgress: (percent, message) => {
      job.progress = { percent, message };
      hooks.onProgress?.(job.progress);
    },
    throwIfAborted: () => {
      if (hooks.isAborted?.()) throw new DOMException('cancelled', 'AbortError');
    },
    warn: (warning) => {
      job.warnings.push(warning);
    },
    openPdfjs: hooks.openPdfjs,
    recodeImage: hooks.recodeImage,
  };

  try {
    job.result = await operation.run(job.files, job.options, ctx);
    job.state = 'done';
  } catch (e) {
    const error = toAppError(e);
    job.error = error;
    job.state = error.code === 'E_CANCELLED' ? 'cancelled' : 'failed';
  } finally {
    job.finishedAt = Date.now();
    job.progress = null;
  }

  return job;
}

/** Milliseconds the run took, or null if it has not finished. */
export function jobDuration(job: PdfJob): number | null {
  if (job.startedAt === null || job.finishedAt === null) return null;
  return job.finishedAt - job.startedAt;
}
