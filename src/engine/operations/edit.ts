/**
 * Edit — find and replace real text, in the file itself.
 *
 * The engine underneath is the one the standalone editor has been using on real
 * invoices for weeks: it rewrites glyph codes in the content stream so the text
 * layer actually changes. Copying text out of an edited file gives the new
 * value. Every free competitor paints a box over the old text and leaves it
 * sitting in the layer underneath, which is why this is the one thing here they
 * cannot match — and why a fallback to painting over is worth a warning rather
 * than a shrug.
 *
 * Nothing about that engine was rewritten to get here. It was already DOM-free
 * and already had the colour sampler as an injected dependency, which is the
 * only reason this file is short.
 */
import type { PdfDocument } from '../../lib/pdf/pdfjs';
import { collectReplacements, readAllPages } from '../../lib/editor/replaceJob';
import { buildEditedPdf } from '../../lib/pdf/exporter';
import type { ReplacementReport } from '../../lib/pdf/exporter';
import type { PageText } from '../../lib/pdf/textExtract';
import { findOnPage } from '../../lib/pdf/textExtract';
import type { SampleTarget } from '../../lib/pdf/sample';
import { createZip } from '../../lib/utils/zip';
import { appError, appWarning } from '../errors';
import { asPdfName, stem } from '../naming';
import { span } from '../types';
import type { JobFile, OperationContext, OperationResult, PdfOperation, PdfjsOpener } from '../types';

export interface EditOptions {
  find: string;
  replace: string;
  scope: 'this-page' | 'all-pages';
  /** 1-based. Only consulted when scope is 'this-page'. */
  page: number;
  /** When the replacement is a different width: squeeze it, or push what follows. */
  fit: 'squeeze' | 'push';
}

export const EDIT_DEFAULTS: EditOptions = {
  find: '',
  replace: '',
  scope: 'all-pages',
  page: 1,
  fit: 'squeeze',
};

// No matchCase option. findOnPage is a plain indexOf, and an option that
// silently does nothing is worse than an absent one. Thai has no case anyway,
// which is what most of these documents are.

/** Scale to rasterise at when sampling patch colours — enough to read a colour, not a glyph. */
const SAMPLE_SCALE = 1.5;

/**
 * Colours for the overlay fallback, read off real pixels in the worker.
 *
 * OffscreenCanvas is why this works here at all. Without it the fallback would
 * paint white patches onto tinted invoice panels, which is exactly the sticker
 * look the native path exists to avoid.
 */
function makeSampler(doc: PdfDocument) {
  // No OffscreenCanvas means no pixels to read — a Node test, most likely. The
  // native path is unaffected; only the overlay fallback loses its colour, and
  // it has a sane default.
  if (typeof OffscreenCanvas === 'undefined') return undefined;

  return async (pageNumber: number): Promise<SampleTarget | null> => {
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: SAMPLE_SCALE });
      const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
      const base = page.getViewport({ scale: 1 });
      return { canvas: canvas as unknown as SampleTarget['canvas'], scale: SAMPLE_SCALE, height: base.height };
    } catch {
      // A page that will not rasterise still edits fine natively; only the
      // overlay fallback loses its colour, and it has a sane default.
      return null;
    }
  };
}

interface FileOutcome {
  name: string;
  bytes: Uint8Array;
  hits: number;
  reports: ReplacementReport[];
  scanned: boolean;
}

async function editOne(
  file: JobFile,
  options: EditOptions,
  openPdfjs: PdfjsOpener,
  ctx: OperationContext,
): Promise<FileOutcome> {
  let handle;
  try {
    handle = await openPdfjs(file.bytes);
  } catch (e) {
    const detail = String((e as Error)?.message ?? e);
    if (/password|encrypt/i.test(detail)) {
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

  const doc = handle.doc;
  try {
    const all = await readAllPages(doc);
    const scanned = all.every((p) => p.items.length === 0);

    const pages: PageText[] =
      options.scope === 'this-page' ? all.filter((p) => p.page === options.page) : all;

    const replacements = await collectReplacements(
      pages,
      options.find,
      options.replace,
      makeSampler(doc),
      options.fit,
    );

    if (replacements.length === 0) {
      return { name: file.name, bytes: file.bytes, hits: 0, reports: [], scanned };
    }

    ctx.throwIfAborted();
    const { bytes, reports } = await buildEditedPdf(file.bytes, replacements);
    return { name: file.name, bytes, hits: replacements.length, reports, scanned };
  } finally {
    handle.close();
  }
}

async function run(files: JobFile[], options: EditOptions, ctx: OperationContext): Promise<OperationResult> {
  if (!options.find) {
    throw appError('E_BAD_OPTIONS', {
      hint: { th: 'ยังไม่ได้ใส่ข้อความที่จะค้นหา', en: 'No search text was given' },
    });
  }

  const openPdfjs = ctx.openPdfjs;
  if (!openPdfjs) {
    throw appError('E_INTERNAL', {
      detail: 'the edit operation needs a text opener and this host did not supply one',
    });
  }

  const at = span(0, 92);
  const outcomes: FileOutcome[] = [];

  for (let i = 0; i < files.length; i++) {
    ctx.throwIfAborted();
    ctx.onProgress(at(i, files.length), {
      th: `กำลังแก้ ${files[i].name}`,
      en: `Editing ${files[i].name}`,
    });
    outcomes.push(await editOne(files[i], options, openPdfjs, ctx));
  }

  const edited = outcomes.filter((o) => o.hits > 0);

  if (edited.length === 0) {
    if (outcomes.every((o) => o.scanned)) {
      throw appError('E_NO_TEXT_LAYER', {
        hint: {
          th: 'เอกสารนี้เป็นภาพสแกน — ไม่มีข้อความให้ค้นหาหรือแก้',
          en: 'These are scans, so there is no text to search or change',
        },
      });
    }
    throw appError('E_TEXT_NOT_FOUND', {
      hint: {
        th: `ไม่พบ "${options.find}" ในเอกสารที่เลือก`,
        en: `"${options.find}" does not appear in the documents you chose`,
      },
    });
  }

  // Files that matched nothing are handed back untouched rather than skipped
  // silently — in a batch, "which ones actually changed" is the whole question.
  const untouched = outcomes.filter((o) => o.hits === 0);
  if (untouched.length > 0) {
    ctx.warn(
      appWarning('W_NO_MATCH_IN_FILE', {
        hint: {
          th: `ไม่พบข้อความใน: ${untouched.map((o) => o.name).join(', ')}`,
          en: `No match in: ${untouched.map((o) => o.name).join(', ')}`,
        },
      }),
    );
  }

  // Painting over is a real downgrade, not a detail: the old text stays in the
  // layer, so copying it out still gives the old value.
  const overlaid = edited.flatMap((o) => o.reports).filter((r) => r.method === 'overlay').length;
  if (overlaid > 0) {
    ctx.warn(
      appWarning('W_EDIT_OVERLAY', {
        hint: {
          th: `${overlaid} จุดจากทั้งหมด ${edited.reduce((n, o) => n + o.hits, 0)} จุด`,
          en: `${overlaid} of ${edited.reduce((n, o) => n + o.hits, 0)} spots`,
        },
      }),
    );
  }

  ctx.onProgress(95, { th: 'กำลังเขียนไฟล์', en: 'Writing the files' });

  const totalHits = edited.reduce((n, o) => n + o.hits, 0);
  const outputs = edited.map((o) => ({
    name: asPdfName(`${stem(o.name)}-แก้แล้ว`),
    bytes: o.bytes,
    mimeType: 'application/pdf',
  }));

  if (outputs.length === 1) {
    return {
      files: outputs,
      stats: {
        originalBytes: files.reduce((n, f) => n + f.bytes.byteLength, 0),
        outputBytes: outputs[0].bytes.byteLength,
        replacements: totalHits,
      },
    };
  }

  // The ZIP writer already sets the UTF-8 flag, which is what makes Thai
  // filenames survive the trip into Windows Explorer.
  const zip = createZip(outputs.map((o) => ({ name: o.name, bytes: o.bytes })));
  return {
    files: [{ name: asPdfName('แก้แล้ว').replace(/\.pdf$/, '') + '.zip', bytes: zip, mimeType: 'application/zip' }],
    stats: {
      originalBytes: files.reduce((n, f) => n + f.bytes.byteLength, 0),
      outputBytes: zip.byteLength,
      replacements: totalHits,
    },
  };
}

/** How many times `needle` appears, per page. Used for the count before running. */
export function countMatches(pages: PageText[], needle: string): { total: number; pages: number[] } {
  if (!needle) return { total: 0, pages: [] };
  let total = 0;
  const hitPages: number[] = [];
  for (const page of pages) {
    const n = findOnPage(page, needle).length;
    if (n > 0) {
      total += n;
      hitPages.push(page.page);
    }
  }
  return { total, pages: hitPages };
}

export const editOperation: PdfOperation<EditOptions> = { id: 'edit', run };
