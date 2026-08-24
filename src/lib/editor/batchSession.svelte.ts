/**
 * Batch mode: one find/replace across a stack of files.
 *
 * Every file goes through the same collect → build path the single-file editor
 * uses, so what a batch produces is exactly what you would have got by opening
 * each file and pressing Apply. The table then says, per file, how many places
 * changed and by which method — because "16 files done" is worth nothing if one
 * of them quietly fell back to painting over the old text.
 */
import { loadPdf } from '../pdf/pdfjs';
import { replaceInDocument } from './replaceJob';
import type { EditMethod, OverflowMode } from '../pdf/exporter';
import { checkPdfFile, createOutputName, downloadBytes } from '../utils/file';
import { createZip, downloadZip, type ZipEntry } from '../utils/zip';

export type RowState = 'waiting' | 'working' | 'done' | 'empty' | 'failed';

export interface BatchRow {
  id: string;
  file: File;
  name: string;
  size: number;
  state: RowState;
  /** How many occurrences were changed. */
  hits: number;
  /** The weakest method used in this file — that is what quality is bounded by. */
  method: EditMethod | null;
  /** True when nothing of the original text is left behind anywhere. */
  clean: boolean;
  message: string;
  bytes: Uint8Array | null;
}

/** Worst-first, so one overlay in a file of natives is what gets reported. */
const METHOD_RANK: Record<EditMethod, number> = { overlay: 0, erase: 1, native: 2 };

export class BatchSession {
  rows = $state.raw<BatchRow[]>([]);
  findText = $state('');
  replaceText = $state('');
  overflow = $state<OverflowMode>('squeeze');
  running = $state(false);
  /** Index of the file being worked on, for the progress line. */
  progress = $state(0);
  error = $state('');
  ran = $state(false);

  get total() {
    return this.rows.length;
  }

  get edited() {
    return this.rows.filter((r) => r.state === 'done');
  }

  get totalHits() {
    return this.rows.reduce((sum, r) => sum + r.hits, 0);
  }

  get untouched() {
    return this.rows.filter((r) => r.state === 'empty');
  }

  get failed() {
    return this.rows.filter((r) => r.state === 'failed');
  }

  /** True when at least one file needed the overlay fallback. */
  get anyOverlay() {
    return this.rows.some((r) => r.method === 'overlay');
  }

  get canRun() {
    return !this.running && this.rows.length > 0 && this.findText.length > 0
      && this.replaceText.length > 0 && this.findText !== this.replaceText;
  }

  add(files: File[]) {
    const accepted: BatchRow[] = [];
    for (const file of files) {
      const verdict = checkPdfFile(file);
      if (!verdict.ok) {
        this.error = `${file.name}: ${verdict.error}`;
        continue;
      }
      if (this.rows.some((r) => r.name === file.name && r.size === file.size)) continue;
      accepted.push({
        id: `${file.name}-${file.size}-${this.rows.length + accepted.length}`,
        file,
        name: file.name,
        size: file.size,
        state: 'waiting',
        hits: 0,
        method: null,
        clean: true,
        message: '',
        bytes: null,
      });
    }
    if (accepted.length > 0) this.rows = [...this.rows, ...accepted];
  }

  remove(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  clear() {
    this.rows = [];
    this.error = '';
    this.ran = false;
    this.progress = 0;
  }

  private patch(id: string, changes: Partial<BatchRow>) {
    this.rows = this.rows.map((r) => (r.id === id ? { ...r, ...changes } : r));
  }

  /** Run the replacement over every file, one after another. */
  async run() {
    if (!this.canRun) return;
    this.running = true;
    this.error = '';
    this.ran = true;
    this.progress = 0;

    // reset previous results so a re-run cannot show stale rows
    this.rows = this.rows.map((r) => ({
      ...r, state: 'waiting' as RowState, hits: 0, method: null, clean: true, message: '', bytes: null,
    }));

    for (const row of this.rows) {
      this.patch(row.id, { state: 'working' });
      try {
        const original = new Uint8Array(await row.file.arrayBuffer());
        const doc = await loadPdf(original);
        // no ink sampler in batch: nothing is on screen to sample, and only the
        // overlay fallback would use it — the row says so when that happens
        const result = await replaceInDocument(original, doc, this.findText, this.replaceText, undefined, this.overflow);

        if (result.hits === 0) {
          this.patch(row.id, {
            state: 'empty',
            message: result.scanned ? 'เป็นไฟล์สแกน — ไม่มีข้อความให้แก้' : `ไม่พบ "${this.findText}"`,
          });
        } else {
          const method = result.reports
            .map((r) => r.method)
            .reduce((worst, m) => (METHOD_RANK[m] < METHOD_RANK[worst] ? m : worst), 'native' as EditMethod);
          this.patch(row.id, {
            state: 'done',
            hits: result.hits,
            method,
            clean: result.reports.every((r) => r.originalRemoved),
            bytes: result.bytes,
            message: '',
          });
        }
      } catch (e) {
        this.patch(row.id, {
          state: 'failed',
          message: e instanceof Error ? e.message : 'แก้ไฟล์นี้ไม่สำเร็จ',
        });
      }
      this.progress++;
    }

    this.running = false;
  }

  downloadOne(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row?.bytes) downloadBytes(row.bytes, createOutputName(row.name));
  }

  /** Everything that actually changed, as one archive. */
  downloadAll() {
    const entries: ZipEntry[] = this.edited
      .filter((r) => r.bytes)
      .map((r) => ({ name: createOutputName(r.name), bytes: r.bytes! }));
    if (entries.length === 0) return;
    if (entries.length === 1) {
      downloadBytes(entries[0].bytes, entries[0].name);
      return;
    }
    downloadZip(createZip(entries), 'pdf-edited.zip');
  }
}
