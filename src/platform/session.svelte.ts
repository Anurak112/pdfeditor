/**
 * The one piece of state the whole workspace reads.
 *
 * Five phases, not the eight a server-backed job needs: with no upload, no
 * queue and no expiry there is nothing for `queued`, `uploading`, `finalizing`
 * or `expired` to mean. Cancelling returns to `ready` rather than a dead
 * `cancelled` state — the files are still open, so throwing the user back to an
 * empty screen would be losing work for no reason.
 */
import { appError, appWarning, toAppError } from '../engine/errors';
import type { AppError } from '../engine/errors';
import { getTool } from '../tools/registry';
import type { AnyTool, LoadedFile, LocalizedString, OutputFile, RunStats, ToolOutput } from '../tools/types';
import { HARD_TOTAL_BYTES, MAX_FILES_PER_JOB, SOFT_TOTAL_BYTES } from '../engine/limits';
import { loadFiles, measureAll } from './loader';
import { MIME_FOR_KIND, sniff } from './loader';
import { prefs } from './prefs.svelte';
import { PageRenderer } from './renderer.svelte';

export type Stage = 'idle' | 'loading' | 'ready' | 'running' | 'done' | 'failed';

export interface Progress {
  percent: number;
  message: LocalizedString;
}

class Session {
  stage = $state<Stage>('idle');
  files = $state<LoadedFile[]>([]);
  toolId = $state<string | null>(null);
  /** Per-tool, so switching tools and coming back keeps what was set. */
  private optionsByTool = $state<Record<string, unknown>>({});

  progress = $state<Progress | null>(null);
  outputs = $state<OutputFile[]>([]);
  stats = $state<RunStats | null>(null);
  warnings = $state<AppError[]>([]);
  error = $state<AppError | null>(null);
  /** Non-fatal notices — over the soft memory line, a file was skipped, and so on. */
  notices = $state<AppError[]>([]);

  /**
   * Rendering for the document on screen — thumbnails and the single-page view.
   *
   * Lives here rather than in the workspace so that switching tools keeps the
   * cache. Re-rasterising 900 pages because someone clicked from Split to
   * Organize would undo the whole point of drawing them lazily.
   */
  thumbs = $state<PageRenderer | null>(null);
  private thumbFileId: string | null = null;

  private abort: AbortController | null = null;

  get tool(): AnyTool | null {
    return getTool(this.toolId);
  }

  get options(): unknown {
    if (!this.toolId) return null;
    return this.optionsByTool[this.toolId] ?? this.tool?.defaultOptions ?? null;
  }

  get totalBytes(): number {
    return this.files.reduce((n, f) => n + f.sizeBytes, 0);
  }

  get totalPages(): number {
    return this.files.reduce((n, f) => n + f.pageCount, 0);
  }

  /** The MIME types actually present, so the home grid can dim tools that cannot take them. */
  get presentMimeTypes(): string[] {
    const set = new Set<string>();
    for (const f of this.files) {
      const kind = sniff(f.bytes);
      if (kind !== 'unknown') set.add(MIME_FOR_KIND[kind]);
    }
    return [...set];
  }

  /**
   * What the user has to change before this can run, or null when nothing.
   *
   * Deliberately excludes "the engine is not written yet" — that is a fact
   * about us, not something they did, and putting it here would hide the
   * prediction line behind a message they cannot act on.
   */
  get blockedReason(): LocalizedString | null {
    const tool = this.tool;
    if (!tool) return null;
    if (this.files.length === 0) {
      return { th: 'ยังไม่ได้เลือกไฟล์', en: 'No files chosen yet' };
    }
    if (this.files.length < tool.minFiles) {
      return {
        th: `เครื่องมือนี้ต้องมีอย่างน้อย ${tool.minFiles} ไฟล์`,
        en: `This tool needs at least ${tool.minFiles} files`,
      };
    }
    if (this.files.length > tool.maxFiles) {
      return {
        th: tool.maxFiles === 1 ? 'เครื่องมือนี้รับได้ไฟล์เดียว' : `รับได้ไม่เกิน ${tool.maxFiles} ไฟล์`,
        en: tool.maxFiles === 1 ? 'This tool takes a single file' : `Takes at most ${tool.maxFiles} files`,
      };
    }
    return null;
  }

  get canRun(): boolean {
    return this.stage === 'ready' && this.blockedReason === null && this.tool?.status === 'ready';
  }

  /** True when the only thing standing in the way is that we have not built it. */
  get toolNotBuilt(): boolean {
    return this.tool !== null && this.tool.status !== 'ready';
  }

  /** The line above the button, from the tool itself. */
  get prediction(): LocalizedString | null {
    const tool = this.tool;
    if (!tool?.predict || this.files.length === 0) return null;
    try {
      return tool.predict(this.files, this.options as never);
    } catch {
      // A prediction is a courtesy; a broken one must never block the run.
      return null;
    }
  }

  async addFiles(picked: File[]) {
    if (picked.length === 0) return;
    this.error = null;

    const room = MAX_FILES_PER_JOB - this.files.length;
    const take = picked.slice(0, Math.max(0, room));
    const dropped = picked.length - take.length;

    this.stage = 'loading';
    const { loaded, errors } = await loadFiles(take);

    // Same bytes twice is nearly always a double-drop, not an intention.
    const seen = new Set(this.files.map((f) => f.name + ':' + f.sizeBytes));
    const fresh = loaded.filter((f) => {
      const key = f.name + ':' + f.sizeBytes;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.files = [...this.files, ...fresh];
    this.notices = errors;

    if (dropped > 0) {
      this.notices = [
        ...this.notices,
        appWarning('W_FILES_DROPPED', {
          hint: {
            th: `รับได้ไม่เกิน ${MAX_FILES_PER_JOB} ไฟล์ — ข้ามไป ${dropped} ไฟล์`,
            en: `The ceiling is ${MAX_FILES_PER_JOB} files, so ${dropped} were skipped`,
          },
        }),
      ];
    }

    if (this.totalBytes > HARD_TOTAL_BYTES) {
      // Past this the tab tends to die rather than fail, so refuse the load
      // instead of letting the user lose the whole session.
      this.files = this.files.slice(0, Math.max(1, this.files.length - fresh.length));
      this.error = appError('E_OUT_OF_MEMORY', {
        hint: {
          th: 'ลองทำทีละชุดที่เล็กกว่านี้',
          en: 'Try a smaller batch at a time',
        },
      });
    } else if (this.totalBytes > SOFT_TOTAL_BYTES) {
      this.notices = [...this.notices, appWarning('W_MEMORY_HIGH')];
    }

    this.stage = this.files.length > 0 ? 'ready' : 'idle';
    this.syncThumbs();
  }

  /** Point the thumbnail set at whatever is now first, and free the old one. */
  private syncThumbs() {
    const file = this.files[0];
    if (!file) {
      this.thumbs?.dispose();
      this.thumbs = null;
      this.thumbFileId = null;
      return;
    }
    if (this.thumbFileId === file.id) return;
    this.thumbs?.dispose();
    this.thumbs = new PageRenderer(file);
    this.thumbFileId = file.id;
  }

  removeFile(id: string) {
    this.files = this.files.filter((f) => f.id !== id);
    if (this.files.length === 0) this.stage = 'idle';
    this.syncThumbs();
  }

  /** Buttons as well as drag: reordering by drag alone is unreachable on a touchscreen. */
  moveFile(id: string, direction: -1 | 1) {
    const i = this.files.findIndex((f) => f.id === id);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= this.files.length) return;
    const next = [...this.files];
    [next[i], next[j]] = [next[j], next[i]];
    this.files = next;
    // Reordering can put a different document first.
    this.syncThumbs();
  }

  selectTool(toolId: string | null) {
    this.toolId = toolId;
    this.clearResult();
  }

  setOptions(patch: Record<string, unknown>) {
    if (!this.toolId) return;
    this.optionsByTool = {
      ...this.optionsByTool,
      [this.toolId]: { ...(this.options as object), ...patch },
    };

    // A failed run leaves the stage at 'failed', and canRun demands 'ready' —
    // so the button went dead until the error was dismissed. Changing a setting
    // is exactly the act of answering the error, and Unlock made it obvious:
    // mistype the password, correct it, press the button, and nothing at all
    // happens. The stale failure clears itself the moment anything changes.
    if (this.stage === 'failed') {
      this.stage = 'ready';
      this.error = null;
    }
  }

  dismissNotices() {
    this.notices = [];
  }

  clearResult() {
    if (this.stage === 'done' || this.stage === 'failed') {
      this.stage = this.files.length > 0 ? 'ready' : 'idle';
    }
    this.outputs = [];
    this.stats = null;
    this.warnings = [];
    this.error = null;
    this.progress = null;
  }

  async run() {
    const tool = this.tool;
    if (!tool || !this.canRun) return;

    const validated = tool.validateOptions(this.options);
    if (!validated.ok) {
      this.error = validated.error;
      this.stage = 'failed';
      return;
    }

    this.abort = new AbortController();
    this.stage = 'running';
    this.progress = { percent: 0, message: { th: 'กำลังเริ่ม…', en: 'Starting…' } };
    this.error = null;
    this.outputs = [];
    this.stats = null;
    this.warnings = [];

    try {
      const out: ToolOutput = await tool.run(
        {
          files: this.files,
          // Unwrap the reactive proxy. Options that came straight from
          // defaultOptions are a plain module object and cross postMessage
          // fine; the moment the user touches a control they become $state,
          // and a proxy cannot be structured-cloned — so the tool worked until
          // someone changed a setting, then failed with DataCloneError.
          options: $state.snapshot(validated.value),
        },
        {
          onProgress: (p) => {
            this.progress = p;
          },
          signal: this.abort.signal,
          locale: prefs.locale,
        },
      );
      this.outputs = out.files;
      this.stats = out.stats ?? null;
      this.warnings = out.warnings ?? [];
      this.stage = 'done';
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'E_CANCELLED') {
        // Files are still open — go back to where the user was, not to nothing.
        // Say so out loud: a screen that silently reverts leaves the user
        // wondering whether the cancel landed or the job is still running.
        this.stage = 'ready';
        this.progress = null;
        this.notices = [appWarning('W_CANCELLED')];
        return;
      }
      if (err.detail) console.warn('[tool:' + tool.id + ']', err.code, err.detail);
      this.error = err;
      this.stage = 'failed';
    } finally {
      this.abort = null;
      this.progress = null;
    }
  }

  cancel() {
    this.abort?.abort();
  }

  /**
   * Feeds this run's output straight into another tool.
   *
   * The whole reason to work locally: the bytes are already in memory, so the
   * next tool starts with no upload and no wait. A server-backed site has to
   * make the user download and re-upload between every step.
   */
  async chainTo(toolId: string) {
    if (this.outputs.length === 0) return;

    // Measured, not assumed. These bytes are input to the next tool in every
    // way that matters, so they go through the same loader an upload does.
    this.stage = 'loading';
    const { loaded, errors } = await measureAll(
      this.outputs.map((o) => ({ name: o.name, bytes: o.bytes })),
    );

    this.files = loaded;
    this.clearResult();
    this.notices = errors;
    this.stage = loaded.length > 0 ? 'ready' : 'idle';
    this.syncThumbs();
    this.selectTool(toolId);
  }

  reset() {
    this.abort?.abort();
    this.abort = null;
    this.files = [];
    this.outputs = [];
    this.stats = null;
    this.warnings = [];
    this.notices = [];
    this.error = null;
    this.progress = null;
    this.stage = 'idle';
    this.syncThumbs();
  }
}

export const session = new Session();
