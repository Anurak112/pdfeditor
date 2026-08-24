/**
 * The whole editor state in one place.
 *
 * The invariant that keeps this simple: the preview always renders the bytes we
 * would hand you on download. Applying a change rebuilds the PDF from the
 * pristine original plus the full replacement list, so undo is just "drop the
 * last entry and rebuild" and what you see is never a simulation of the result.
 */
import { loadPdf, type PdfDocument } from '../pdf/pdfjs';
import { findOnPage, type PageText, type TextHit } from '../pdf/textExtract';
import { buildEditedPdf, type OverflowMode, type Replacement, type ReplacementReport } from '../pdf/exporter';
import { renderPage, type RenderedPage } from '../pdf/render';
import { collectReplacements, readAllPages, type InkSampler } from './replaceJob';
import { checkPdfFile, createOutputName, downloadBytes } from '../utils/file';

export type Stage = 'upload' | 'loading' | 'editor';
/** Which occurrences an Apply acts on. */
export type Scope = 'page' | 'all';

export class EditorSession {
  stage = $state<Stage>('upload');
  error = $state('');
  busy = $state('');

  fileName = $state('');
  fileSize = $state(0);
  originalBytes: Uint8Array | null = null;

  /** Bytes currently previewed — original until something is applied. */
  previewBytes = $state.raw<Uint8Array | null>(null);
  // raw: these are always swapped wholesale, and pdf.js documents must not be proxied
  previewDoc = $state.raw<PdfDocument | null>(null);
  pages = $state.raw<PageText[]>([]);
  pageCount = $state(0);
  currentPage = $state(1);

  findText = $state('246/8');
  replaceText = $state('135/7');
  /** Index within `hits` that Apply will act on; -1 means "not just one". */
  selectedHit = $state(-1);
  /** This page only, or every page in the file. */
  scope = $state<Scope>('page');
  /** What to do when the new text is wider than the old: tighten it, or move the line along. */
  overflow = $state<OverflowMode>('squeeze');

  /** One entry per Apply, so Undo can take back exactly what one press added. */
  history = $state.raw<Replacement[][]>([]);
  replacements = $derived.by<Replacement[]>(() => this.history.flat());
  reports = $state.raw<ReplacementReport[]>([]);

  /** Set by the viewer after each render, so Apply can sample real pixels. */
  rendered: RenderedPage | null = null;

  hits = $derived.by<TextHit[]>(() => {
    const page = this.pages.find((p) => p.page === this.currentPage);
    if (!page || !this.findText) return [];
    return findOnPage(page, this.findText);
  });

  appliedHits = $derived.by<TextHit[]>(() => {
    if (this.replacements.length === 0 || !this.replaceText) return [];
    const page = this.pages.find((p) => p.page === this.currentPage);
    return page ? findOnPage(page, this.replaceText) : [];
  });

  totalHits = $derived.by(() => {
    if (!this.findText) return 0;
    return this.pages.reduce((sum, p) => sum + findOnPage(p, this.findText).length, 0);
  });

  /** How many occurrences the next Apply would change. */
  targetCount = $derived.by(() => {
    if (this.selectedHit >= 0) return this.hits.length > 0 ? 1 : 0;
    return this.scope === 'all' ? this.totalHits : this.hits.length;
  });

  get dirty() {
    return this.replacements.length > 0;
  }

  get outputName() {
    return createOutputName(this.fileName || 'document.pdf');
  }

  async open(file: File) {
    const verdict = checkPdfFile(file);
    if (!verdict.ok) {
      this.error = verdict.error!;
      return;
    }
    this.error = '';
    this.stage = 'loading';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
        throw new Error('ไม่สามารถเปิดไฟล์ PDF นี้ได้ (ไม่ใช่ไฟล์ PDF ที่ถูกต้อง)');
      }
      this.fileName = file.name;
      this.fileSize = file.size;
      this.originalBytes = bytes;
      this.history = [];
      this.reports = [];
      this.currentPage = 1;
      this.selectedHit = -1;
      await this.usePreview(bytes);

      const withText = this.pages.some((p) => p.items.length > 0);
      if (!withText) {
        this.error = 'ไม่พบข้อความที่แก้ไขได้ — PDF นี้อาจเป็นเอกสารสแกน (ยังไม่รองรับ OCR)';
      }
      this.stage = 'editor';
    } catch (e) {
      this.stage = 'upload';
      this.error = e instanceof Error ? e.message : 'ไม่สามารถเปิดไฟล์ PDF นี้ได้';
    }
  }

  private async usePreview(bytes: Uint8Array) {
    this.previewDoc = await loadPdf(bytes);
    this.pageCount = this.previewDoc.numPages;
    this.pages = await readAllPages(this.previewDoc);
    this.previewBytes = bytes;
    if (this.currentPage > this.pageCount) this.currentPage = 1;
  }

  /**
   * Rasterise a page so patch colours come from real pixels.
   * The page on screen is already rendered; others are drawn on demand.
   */
  private sampler: InkSampler = async (pageNumber) => {
    if (pageNumber === this.currentPage && this.rendered) return this.rendered;
    if (!this.previewDoc) return null;
    try {
      return await renderPage(this.previewDoc, pageNumber, 2);
    } catch {
      return null;
    }
  };

  /** Build the Replacement records for what the user has selected right now. */
  private async buildReplacements(): Promise<Replacement[]> {
    const currentPage = this.pages.find((p) => p.page === this.currentPage);

    if (this.selectedHit >= 0) {
      // one specific highlight on this page
      const hit = this.hits[this.selectedHit];
      if (!hit || !currentPage) return [];
      const single: PageText = { ...currentPage, items: [hit.item] };
      const built = await collectReplacements([single], this.findText, this.replaceText, this.sampler, this.overflow);
      // findOnPage recounts ordinals within the trimmed page, so restore the real one
      return built.slice(0, 1).map((r) => ({ ...r, ordinal: hit.ordinal, id: `${r.id}-sel` }));
    }

    const scopePages = this.scope === 'all' ? this.pages : currentPage ? [currentPage] : [];
    return collectReplacements(scopePages, this.findText, this.replaceText, this.sampler, this.overflow);
  }

  async apply() {
    if (!this.originalBytes) return;
    if (!this.replaceText.trim()) {
      this.error = 'กรุณาระบุข้อความใหม่';
      return;
    }
    if (this.targetCount === 0) {
      this.error = this.scope === 'all'
        ? `ไม่พบข้อความ "${this.findText}" ในไฟล์นี้`
        : `ไม่พบข้อความ "${this.findText}" ในหน้านี้`;
      return;
    }
    this.error = '';
    this.busy = 'กำลังแก้ไข…';
    try {
      const added = await this.buildReplacements();
      const next = [...this.replacements, ...added];
      const { bytes, reports } = await buildEditedPdf(this.originalBytes, next);
      this.history = [...this.history, added];
      this.reports = reports;
      this.selectedHit = -1;
      await this.usePreview(bytes);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'ไม่สามารถสร้าง PDF ได้ กรุณาลองใหม่';
    } finally {
      this.busy = '';
    }
  }

  async undo() {
    if (!this.originalBytes || this.history.length === 0) return;
    this.busy = 'กำลังย้อนกลับ…';
    this.error = '';
    try {
      // one Apply may have changed several places — take the whole press back
      const history = this.history.slice(0, -1);
      const next = history.flat();

      if (next.length === 0) {
        this.history = [];
        this.reports = [];
        await this.usePreview(this.originalBytes);
      } else {
        const { bytes, reports } = await buildEditedPdf(this.originalBytes, next);
        this.history = history;
        this.reports = reports;
        await this.usePreview(bytes);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'ย้อนกลับไม่สำเร็จ';
    } finally {
      this.busy = '';
    }
  }

  download() {
    if (!this.previewBytes) return;
    downloadBytes(this.previewBytes, this.outputName);
  }

  reset() {
    this.stage = 'upload';
    this.error = '';
    this.busy = '';
    this.fileName = '';
    this.fileSize = 0;
    this.originalBytes = null;
    this.previewBytes = null;
    this.previewDoc = null;
    this.pages = [];
    this.pageCount = 0;
    this.currentPage = 1;
    this.history = [];
    this.reports = [];
    this.rendered = null;
    this.selectedHit = -1;
    this.scope = 'page';
    this.overflow = 'squeeze';
  }
}
