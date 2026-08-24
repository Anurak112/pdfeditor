/**
 * Opening documents, once, for everyone.
 *
 * Merge grew about sixty lines of "load each file, work out whether a failure
 * means encrypted or damaged, name the file in the message, parse a page range,
 * clamp it" — and Split, Organize, Compress and Convert were all going to grow
 * their own slightly different copy. Then the same broken PDF would produce a
 * different message depending on which tool the user happened to pick.
 *
 * This is that logic, in one place, with the filename already in the error.
 */
import { PDFDocument } from 'pdf-lib';
import { appError, appWarning } from './errors';
import type { AppError } from './errors';
import { parseRangeSpec } from './ranges';
import { MAX_PAGES_PER_JOB } from './limits';
import { span } from './types';
import type { JobFile, OperationContext } from './types';

export class PdfSource {
  readonly file: JobFile;
  readonly doc: PDFDocument;

  private constructor(file: JobFile, doc: PDFDocument) {
    this.file = file;
    this.doc = doc;
  }

  static async open(file: JobFile): Promise<PdfSource> {
    try {
      // updateMetadata defaults to true, and what it does is stamp pdf-lib's
      // own name as the document's Producer and today's date as its ModDate,
      // before any tool has touched it. Every tool here inherited that: rotate
      // one page and the file quietly forgot which program authored it. Off.
      const doc = await PDFDocument.load(file.bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
      return new PdfSource(file, doc);
    } catch (e) {
      const detail = String((e as Error)?.message ?? e);
      // pdf-lib reports both of these as ordinary throws, and the difference
      // matters: one has a way out, the other does not.
      if (/encrypt|password/i.test(detail)) {
        throw appError('E_ENCRYPTED', {
          hint: { th: `ไฟล์ที่ล็อกอยู่คือ ${file.name}`, en: `The locked file is ${file.name}` },
          detail,
        });
      }
      throw appError('E_CORRUPT', {
        hint: { th: `เปิด ${file.name} ไม่ได้`, en: `Could not open ${file.name}` },
        detail,
      });
    }
  }

  get name(): string {
    return this.file.name;
  }

  get id(): string {
    return this.file.id;
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  /**
   * Which pages this source contributes.
   *
   * An empty or missing spec means the whole document. A spec that selects
   * nothing is an error rather than an empty result — silently contributing
   * zero pages is how someone ends up with a file missing a section they
   * thought they had asked for. A spec that overshoots the end is clamped and
   * reported, because "11-" on a nine-page file plainly means "to the end".
   */
  pickPages(spec: string | undefined, ctx: OperationContext): number[] {
    const trimmed = spec?.trim();
    if (!trimmed) return this.doc.getPageIndices();

    const parsed = parseRangeSpec(trimmed, this.pageCount);
    if (parsed.pages.length === 0) {
      throw appError('E_RANGE_OUT_OF_BOUNDS', {
        hint: {
          th: `ช่วง "${trimmed}" ของ ${this.name} ใช้ไม่ได้ — ไฟล์นี้มี ${this.pageCount} หน้า`,
          en: `Range "${trimmed}" on ${this.name} selects nothing — that file has ${this.pageCount} pages`,
        },
      });
    }
    if (parsed.outOfBounds.length > 0) {
      ctx.warn(
        appWarning('W_RANGE_CLAMPED', {
          hint: {
            th: `${this.name}: ข้าม "${parsed.outOfBounds.join(', ')}" เพราะเกิน ${this.pageCount} หน้า`,
            en: `${this.name}: skipped "${parsed.outOfBounds.join(', ')}" — past its ${this.pageCount} pages`,
          },
        }),
      );
    }
    return parsed.pages;
  }

  /** Page size in PDF user space. */
  sizeOf(index: number): [number, number] {
    const { width, height } = this.doc.getPage(index).getSize();
    return [width, height];
  }
}

export interface OpenedSource {
  source: PdfSource;
  /** The pages this source contributes, already resolved and validated. */
  pages: number[];
}

export interface OpenOptions {
  /** Per-file page range, keyed by file id. */
  pageRanges?: Record<string, string>;
  /** Progress slice to report inside while opening. */
  progress?: { from: number; to: number };
  /** Below this many usable sources, give up. */
  minSources?: number;
}

/**
 * Opens every input before any of them is written.
 *
 * Failing on file five after four have already been processed wastes the wait
 * and, worse, leaves the user unsure whether anything happened. Sources with no
 * pages are skipped with a warning rather than failing the run — an empty PDF
 * among five good ones should not cost the other four.
 */
export async function openSources(
  files: JobFile[],
  options: OpenOptions,
  ctx: OperationContext,
): Promise<OpenedSource[]> {
  const { from = 0, to = 40 } = options.progress ?? {};
  const at = span(from, to);
  const opened: OpenedSource[] = [];
  let totalPages = 0;

  for (let i = 0; i < files.length; i++) {
    ctx.throwIfAborted();
    const file = files[i];
    ctx.onProgress(at(i, files.length), {
      th: `กำลังเปิด ${file.name}`,
      en: `Opening ${file.name}`,
    });

    const source = await PdfSource.open(file);

    if (source.pageCount === 0) {
      ctx.warn(
        appWarning('W_FILE_SKIPPED', {
          hint: { th: `${file.name} ไม่มีหน้าเลย`, en: `${file.name} has no pages` },
        }),
      );
      continue;
    }

    const pages = source.pickPages(options.pageRanges?.[file.id], ctx);
    totalPages += pages.length;
    opened.push({ source, pages });
  }

  const min = options.minSources ?? 1;
  if (opened.length < min) {
    throw appError('E_TOO_FEW_FILES', {
      hint: {
        th: `หลังข้ามไฟล์ที่ใช้ไม่ได้แล้ว เหลือไม่ถึง ${min} ไฟล์`,
        en: `After skipping the unusable files there were fewer than ${min} left`,
      },
    });
  }

  if (totalPages > MAX_PAGES_PER_JOB) {
    throw appError('E_TOO_MANY_PAGES', {
      hint: {
        th: `รวมกันได้ ${totalPages} หน้า — เกินเพดาน ${MAX_PAGES_PER_JOB} หน้า`,
        en: `That comes to ${totalPages} pages, past the ${MAX_PAGES_PER_JOB} ceiling`,
      },
    });
  }

  return opened;
}

/** Total pages across opened sources, after ranges have been applied. */
export function pageTotal(sources: OpenedSource[]): number {
  return sources.reduce((n, s) => n + s.pages.length, 0);
}

export type { AppError };
