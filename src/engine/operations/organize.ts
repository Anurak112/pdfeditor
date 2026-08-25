/**
 * Organize — rotate, delete and reorder pages.
 *
 * Four tools' worth of user-facing capability for about a hundred lines,
 * because the page grid already existed. That was the bet when the grid was
 * built before any tool that needed it, and this is where it pays.
 */
import { degrees } from 'pdf-lib';
import { appError, appWarning } from '../errors';
import { openSources } from '../document';
import { blankDocument, carryInfo } from '../metadata';
import { asPdfName, stem } from '../naming';
import { span } from '../types';
import type { JobFile, OperationContext, OperationResult, PdfOperation } from '../types';

export type Quarter = 0 | 90 | 180 | 270;

export interface OrganizeOptions {
  /** Final page order as 0-based source indices. Empty means the original order. */
  order: number[];
  /** Extra rotation on top of what the page already had, by source index. */
  rotations: Record<number, Quarter>;
  /** Source indices to drop. */
  deleted: number[];
  outputName: string;
}

export const ORGANIZE_DEFAULTS: OrganizeOptions = {
  order: [],
  rotations: {},
  deleted: [],
  outputName: '',
};

/**
 * The page list this run will actually produce.
 *
 * Shared with the UI so the count above the button and the file that comes out
 * are computed the same way. A prediction derived separately is a prediction
 * that eventually disagrees.
 */
export function finalOrder(pageCount: number, options: OrganizeOptions): number[] {
  const base = options.order.length > 0 ? options.order : Array.from({ length: pageCount }, (_, i) => i);
  const dropped = new Set(options.deleted);
  // Filter against the real page count too: a stale order from a previous file
  // would otherwise ask for pages that are not there.
  return base.filter((i) => i >= 0 && i < pageCount && !dropped.has(i));
}

/** True when the options would produce a copy of the input and nothing more. */
export function isUnchanged(pageCount: number, options: OrganizeOptions): boolean {
  const order = finalOrder(pageCount, options);
  if (order.length !== pageCount) return false;
  if (order.some((page, at) => page !== at)) return false;
  return Object.values(options.rotations).every((r) => r % 360 === 0);
}

async function run(files: JobFile[], options: OrganizeOptions, ctx: OperationContext): Promise<OperationResult> {
  const [opened] = await openSources(files, { progress: { from: 0, to: 25 }, minSources: 1 }, ctx);
  const source = opened.source;
  const pageCount = source.pageCount;

  const order = finalOrder(pageCount, options);
  if (order.length === 0) {
    throw appError('E_NO_PAGES_SELECTED', {
      hint: {
        th: 'ลบทุกหน้าแล้วจะไม่เหลืออะไรเลย — เก็บไว้อย่างน้อยหนึ่งหน้า',
        en: 'Deleting every page leaves nothing — keep at least one',
      },
    });
  }

  if (isUnchanged(pageCount, options)) {
    ctx.warn(
      appWarning('W_NOTHING_CHANGED', {
        hint: {
          th: 'ยังไม่ได้หมุน ลบ หรือย้ายหน้าไหนเลย — ไฟล์ที่ได้จะเหมือนเดิม',
          en: 'Nothing was rotated, deleted or moved, so the result matches the original',
        },
      }),
    );
  }

  ctx.throwIfAborted();
  const out = await blankDocument();

  // Copied in one call rather than page by page: pdf-lib deduplicates shared
  // resources across a single copyPages, and fonts are almost always shared.
  const copied = await out.copyPages(source.doc, order);
  const at = span(25, 90);

  for (let i = 0; i < copied.length; i++) {
    ctx.throwIfAborted();
    if (i % 25 === 0) {
      ctx.onProgress(at(i, copied.length), {
        th: `กำลังจัดหน้า ${i + 1} จาก ${copied.length}`,
        en: `Arranging page ${i + 1} of ${copied.length}`,
      });
    }

    const page = copied[i];
    const extra = options.rotations[order[i]] ?? 0;
    if (extra % 360 !== 0) {
      // Added to what the page already carries — a page that arrived sideways
      // and gets turned once should end up upright, not sideways again.
      const current = page.getRotation().angle;
      page.setRotation(degrees(((current + extra) % 360 + 360) % 360));
    }
    out.addPage(page);
  }

  // Outlines point at pages by reference, and copyPages does not carry them.
  // Saying so beats letting someone discover their bookmarks vanished.
  if (order.length !== pageCount || options.order.length > 0) {
    ctx.warn(appWarning('W_BOOKMARKS_DROPPED'));
  }

  // Same document, pages rearranged — so its description and the program that
  // authored it come along, and only /Producer becomes ours.
  carryInfo(out, source.doc, { creationDate: true });

  ctx.onProgress(94, { th: 'กำลังเขียนไฟล์', en: 'Writing the file' });
  const bytes = await out.save({ useObjectStreams: true });
  const name = asPdfName(options.outputName || `${stem(files[0].name)}-จัดหน้าแล้ว`);

  return {
    files: [{ name, bytes, mimeType: 'application/pdf' }],
    stats: {
      originalBytes: files[0].bytes.byteLength,
      outputBytes: bytes.byteLength,
      pagesProcessed: order.length,
    },
  };
}

export const organizeOperation: PdfOperation<OrganizeOptions> = { id: 'organize', run };
