/**
 * Merge — several PDFs into one.
 *
 * Rewritten onto the shared primitives after it was the only engine there was.
 * What is left here is only what is actually specific to merging; opening
 * inputs, page ranges, bookmarks and filenames all moved out, because Split and
 * Organize need the same things and three near-identical copies is how a fix in
 * one of them fails to reach the other two.
 */
import type { PDFDocument } from 'pdf-lib';
import { appWarning } from '../errors';
import { openSources, pageTotal } from '../document';
import type { OpenedSource } from '../document';
import { blankDocument, carryInfo } from '../metadata';
import { asPdfName, stem } from '../naming';
import { writeOutline } from '../outline';
import type { OutlineEntry } from '../outline';
import { span } from '../types';
import type { JobFile, OperationContext, OperationResult, PdfOperation } from '../types';

export interface MergeOptions {
  // No `order` field on purpose. The merge order is the file list the caller
  // hands over, and one fact with two homes is how a reordered list and a stale
  // array end up disagreeing about what the user asked for.
  pageRanges: Record<string, string>;
  addBookmarks: boolean;
  pageSize: 'keep' | 'first' | 'a4';
  /**
   * Where the output's document details come from. 'first' takes them — title,
   * author, subject, keywords, and /Creator, the program that authored the
   * content — from the first file; 'none' leaves the lot out. /Producer says
   * this app either way, because this app is what wrote the bytes.
   */
  keepMetadata: 'first' | 'none';
  outputName: string;
}

export const MERGE_DEFAULTS: MergeOptions = {
  pageRanges: {},
  addBookmarks: true,
  pageSize: 'keep',
  keepMetadata: 'first',
  outputName: '',
};

const A4: [number, number] = [595.28, 841.89];

async function run(files: JobFile[], options: MergeOptions, ctx: OperationContext): Promise<OperationResult> {
  const sources = await openSources(
    files,
    { pageRanges: options.pageRanges, progress: { from: 0, to: 40 }, minSources: 2 },
    ctx,
  );

  ctx.throwIfAborted();
  const out = await blankDocument();

  // "Keep" copies pages whole, which preserves links and annotations. The
  // fixed-size modes have to redraw each page onto a new one, and that is a
  // real loss — so keep is the default and the others say what they cost.
  const target =
    options.pageSize === 'a4'
      ? A4
      : options.pageSize === 'first'
        ? sources[0].source.sizeOf(sources[0].pages[0] ?? 0)
        : null;

  if (target) ctx.warn(appWarning('W_PAGE_SIZE_REDRAW'));

  const bookmarks: OutlineEntry[] = [];
  const at = span(40, 95);
  let written = 0;

  for (let i = 0; i < sources.length; i++) {
    ctx.throwIfAborted();
    const { source, pages } = sources[i];
    ctx.onProgress(at(i, sources.length), {
      th: `กำลังรวม ${source.name}`,
      en: `Adding ${source.name}`,
    });

    bookmarks.push({ title: stem(source.name), pageIndex: written });
    written += target ? await redraw(out, source, pages, target, ctx) : await copy(out, source, pages);
  }

  ctx.throwIfAborted();
  // No creation date carried across, even under 'first': the merged file is a
  // compilation that did not exist until now, and dating it 2019 because its
  // first chapter was written in 2019 would be a fact about a different
  // document. The single-source tools do carry it — see carryInfo.
  carryInfo(out, options.keepMetadata === 'first' ? sources[0].source.doc : null);
  if (options.addBookmarks) writeOutline(out, bookmarks);

  ctx.onProgress(96, { th: 'กำลังเขียนไฟล์', en: 'Writing the file' });
  const bytes = await out.save({ useObjectStreams: true });

  const name = asPdfName(options.outputName || `${stem(files[0].name)}-รวม`);

  return {
    files: [{ name, bytes, mimeType: 'application/pdf' }],
    stats: {
      originalBytes: files.reduce((n, f) => n + f.bytes.byteLength, 0),
      outputBytes: bytes.byteLength,
      pagesProcessed: written,
    },
  };
}

/** The cheap path: pages carry across whole, links and annotations included. */
async function copy(out: PDFDocument, source: OpenedSource['source'], pages: number[]): Promise<number> {
  const copied = await out.copyPages(source.doc, pages);
  for (const page of copied) out.addPage(page);
  return copied.length;
}

/** The lossy path: each page redrawn onto a fixed-size sheet, scaled and centred. */
async function redraw(
  out: PDFDocument,
  source: OpenedSource['source'],
  pages: number[],
  [tw, th]: [number, number],
  ctx: OperationContext,
): Promise<number> {
  let n = 0;
  for (const index of pages) {
    ctx.throwIfAborted();
    const embedded = await out.embedPage(source.doc.getPage(index));
    const scale = Math.min(tw / embedded.width, th / embedded.height);
    const page = out.addPage([tw, th]);
    page.drawPage(embedded, {
      xScale: scale,
      yScale: scale,
      x: (tw - embedded.width * scale) / 2,
      y: (th - embedded.height * scale) / 2,
    });
    n++;
  }
  return n;
}

export const mergeOperation: PdfOperation<MergeOptions> = { id: 'merge', run };

export { pageTotal };
