/**
 * Bookmarks.
 *
 * pdf-lib has no outline API, so this assembles the dictionaries by hand. It
 * lives in the engine because Merge is not the only tool that wants them —
 * Split has a keepBookmarks option and Organize has to survive reordering — and
 * one of them getting the string encoding wrong is a bug you only see in the
 * bookmarks pane of a reader nobody tested with.
 */
import { PDFHexString, PDFName, PDFNull, PDFNumber } from 'pdf-lib';
import type { PDFDocument, PDFRef } from 'pdf-lib';

export interface OutlineEntry {
  title: string;
  /** 0-based page index in the finished document. */
  pageIndex: number;
}

/**
 * Writes a flat outline, one entry per source.
 *
 * Titles go in as PDFHexString rather than PDFString. A literal string is
 * PDFDocEncoding, which has no Thai — every Thai filename would land in the
 * bookmarks pane as mojibake. fromText writes UTF-16BE with a byte-order mark,
 * which readers understand.
 */
export function writeOutline(pdf: PDFDocument, entries: OutlineEntry[]) {
  if (entries.length === 0) return;

  const context = pdf.context;
  const outlinesRef = context.nextRef();
  const itemRefs: PDFRef[] = entries.map(() => context.nextRef());
  const pages = pdf.getPages();

  entries.forEach((entry, i) => {
    const page = pages[entry.pageIndex];
    if (!page) return;

    const dict = context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: outlinesRef,
      // XYZ with nulls means "this page, keep the reader's current zoom".
      Dest: context.obj([page.ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]),
    });
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < entries.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1]);
    context.assign(itemRefs[i], dict);
  });

  const outlines = context.obj({
    Type: 'Outlines',
    First: itemRefs[0],
    Last: itemRefs[itemRefs.length - 1],
    Count: PDFNumber.of(entries.length),
  });
  context.assign(outlinesRef, outlines);
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
}
