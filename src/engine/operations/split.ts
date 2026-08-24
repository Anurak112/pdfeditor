/**
 * Split — take pages out, or cut a document into several.
 *
 * Five modes rather than one, because "split" means five different things to
 * the people who ask for it: give me page 7, give me each page as its own file,
 * cut this into chapters of ten, cut it at these boundaries, or get rid of the
 * pages I do not want. One text box asking for "1-5, 6-12" can only express the
 * fourth, and only if you already know what is on those pages.
 */
import { PDFDocument } from 'pdf-lib';
import { appError, appWarning } from '../errors';
import { openSources } from '../document';
import { asPdfName, fillPattern, sanitiseFilename, stem } from '../naming';
import { parseRangeGroups } from '../ranges';
import { createZip } from '../../lib/utils/zip';
import { span } from '../types';
import type { JobFile, OperationContext, OperationResult, OutputFile, PdfOperation } from '../types';

export type SplitMode = 'extract-merged' | 'extract-separate' | 'every-n' | 'ranges' | 'remove';

export interface SplitOptions {
  mode: SplitMode;
  /** 0-based page indices, for the extract and remove modes. The grid fills this. */
  pages: number[];
  everyN: number;
  /** For 'ranges', as typed: '1-5, 6-12, 13-'. */
  ranges: string;
  /** <name> and <nn> are filled in; the counter is padded so 2 sorts before 10. */
  namePattern: string;
  zipWhenMultiple: boolean;
}

export const SPLIT_DEFAULTS: SplitOptions = {
  mode: 'extract-merged',
  pages: [],
  everyN: 5,
  ranges: '',
  namePattern: '<name>-<nn>.pdf',
  zipWhenMultiple: true,
};

// No keepBookmarks option. copyPages cannot carry an outline, and an option
// that cannot do what its name says is worse than one that is absent — so the
// operation warns when bookmarks are lost instead of pretending to keep them.

export interface SplitPlan {
  /** One entry per output file, each a list of 0-based source page indices. */
  groups: number[][];
  /** Ranges the user typed that fall outside the document. */
  outOfBounds: string[];
}

/**
 * What this run would produce, worked out without touching the document.
 *
 * Shared with the prediction line so the count above the button and the files
 * that come out cannot disagree.
 */
export function splitPlan(pageCount: number, options: SplitOptions): SplitPlan {
  const inRange = (i: number) => i >= 0 && i < pageCount;
  const selected = [...new Set(options.pages)].filter(inRange).sort((a, b) => a - b);
  const all = Array.from({ length: pageCount }, (_, i) => i);

  switch (options.mode) {
    case 'extract-merged':
      return { groups: selected.length > 0 ? [selected] : [], outOfBounds: [] };

    case 'extract-separate':
      return { groups: selected.map((p) => [p]), outOfBounds: [] };

    case 'remove': {
      const dropped = new Set(selected);
      const kept = all.filter((i) => !dropped.has(i));
      return { groups: kept.length > 0 ? [kept] : [], outOfBounds: [] };
    }

    case 'every-n': {
      const n = Math.max(1, Math.floor(options.everyN));
      const groups: number[][] = [];
      for (let i = 0; i < pageCount; i += n) groups.push(all.slice(i, i + n));
      return { groups, outOfBounds: [] };
    }

    case 'ranges':
      return parseRangeGroups(options.ranges, pageCount);
  }
}

async function run(files: JobFile[], options: SplitOptions, ctx: OperationContext): Promise<OperationResult> {
  const [opened] = await openSources(files, { progress: { from: 0, to: 20 }, minSources: 1 }, ctx);
  const source = opened.source;
  const plan = splitPlan(source.pageCount, options);

  if (plan.outOfBounds.length > 0) {
    ctx.warn(
      appWarning('W_RANGE_CLAMPED', {
        hint: {
          th: `ข้าม "${plan.outOfBounds.join(', ')}" เพราะเกิน ${source.pageCount} หน้า`,
          en: `Skipped "${plan.outOfBounds.join(', ')}" — past the document's ${source.pageCount} pages`,
        },
      }),
    );
  }

  if (plan.groups.length === 0) {
    if (options.mode === 'remove') {
      throw appError('E_NO_PAGES_SELECTED', {
        hint: {
          th: 'ลบทุกหน้าแล้วจะไม่เหลืออะไรเลย',
          en: 'Removing every page leaves nothing behind',
        },
      });
    }
    if (options.mode === 'ranges') {
      throw appError('E_RANGE_OUT_OF_BOUNDS', {
        hint: {
          th: `ช่วงที่ระบุใช้ไม่ได้ — เอกสารนี้มี ${source.pageCount} หน้า`,
          en: `Those ranges select nothing — this document has ${source.pageCount} pages`,
        },
      });
    }
    throw appError('E_NO_PAGES_SELECTED');
  }

  const base = sanitiseFilename(stem(files[0].name));
  const at = span(20, 90);
  const outputs: OutputFile[] = [];

  for (let g = 0; g < plan.groups.length; g++) {
    ctx.throwIfAborted();
    ctx.onProgress(at(g, plan.groups.length), {
      th: `กำลังสร้างไฟล์ที่ ${g + 1} จาก ${plan.groups.length}`,
      en: `Building file ${g + 1} of ${plan.groups.length}`,
    });

    const out = await PDFDocument.create();
    const copied = await out.copyPages(source.doc, plan.groups[g]);
    for (const page of copied) out.addPage(page);
    out.setProducer('Simple PDF');
    out.setCreator('Simple PDF');

    const name =
      plan.groups.length === 1
        ? asPdfName(`${base}-ตัดแล้ว`)
        : asPdfName(
            fillPattern(options.namePattern, { name: base, n: g + 1, total: plan.groups.length }),
          );

    outputs.push({ name, bytes: await out.save({ useObjectStreams: true }), mimeType: 'application/pdf' });
  }

  // Outlines point at pages by reference and do not survive copyPages. Saying
  // so beats letting someone find their bookmarks missing later.
  ctx.warn(appWarning('W_BOOKMARKS_DROPPED'));

  const pagesProcessed = plan.groups.reduce((n, g) => n + g.length, 0);
  const originalBytes = files[0].bytes.byteLength;

  if (outputs.length === 1 || !options.zipWhenMultiple) {
    return {
      files: outputs,
      stats: {
        originalBytes,
        outputBytes: outputs.reduce((n, o) => n + o.bytes.byteLength, 0),
        pagesProcessed,
      },
    };
  }

  ctx.onProgress(94, { th: 'กำลังห่อ ZIP', en: 'Packing the ZIP' });
  // The ZIP writer sets the UTF-8 flag, which is what makes Thai filenames
  // survive the trip into Windows Explorer.
  const zip = createZip(outputs.map((o) => ({ name: o.name, bytes: o.bytes })));

  return {
    files: [{ name: sanitiseFilename(`${base}-ตัดแล้ว`) + '.zip', bytes: zip, mimeType: 'application/zip' }],
    stats: { originalBytes, outputBytes: zip.byteLength, pagesProcessed },
  };
}

export const splitOperation: PdfOperation<SplitOptions> = { id: 'split', run };
