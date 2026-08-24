/**
 * The ceilings, in one place so the UI and the loader cannot disagree.
 *
 * These are browser-memory limits, not billing limits — nobody is paying for
 * this compute but the person whose laptop is doing it. The soft warning exists
 * because the honest failure of a client-side tool is "your machine ran out of
 * room", and that is much better said before the work starts than after.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Refused at load: a single document longer than this. */
export const MAX_PAGES_PER_FILE = 2000;
/**
 * Refused at run: everything one job would write, added up.
 *
 * A separate name from the per-file ceiling even though they are equal today.
 * Merging twenty contracts is a different question from opening one enormous
 * book, and sharing one constant meant the error message named the wrong limit.
 */
export const MAX_PAGES_PER_JOB = 2000;
export const MAX_FILES_PER_JOB = 20;

/** Warn above this much loaded at once. */
export const SOFT_TOTAL_BYTES = 100 * 1024 * 1024;
/** Refuse above this much — past here the tab tends to die rather than fail. */
export const HARD_TOTAL_BYTES = 250 * 1024 * 1024;

/** Work faster than this renders no progress panel: a flash of one is worse than none. */
export const PROGRESS_MIN_MS = 300;
