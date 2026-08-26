/**
 * Hand-built PDFs that force specific paths through the editor.
 *
 * The real invoices we test against all take the fast path now, which means the
 * erase fallback and the `Tm`-shifting half of push mode were running untested.
 * These files are written operator by operator so each case is reachable on
 * purpose rather than by luck:
 *
 *  · mixedPlacement — one word split across tokens that are positioned two
 *    different ways. Rewriting in place is refused, so the editor must delete
 *    the old glyphs and redraw (erase), NOT paint over them (overlay).
 *  · separateRuns — the rest of the line is placed by its own `Tm`, so pushing
 *    has to edit that matrix for anything to move.
 */
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Build a one-page PDF whose content stream is exactly `ops`. */
async function pageWithOps(build: (fontKey: string) => string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([320, 160]);
  // draw once so the font is bound into the page's resources, then replace the
  // stream wholesale with our own operators
  page.drawText('.', { font, size: 6, x: 2, y: 2 });

  const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
  const entry = fonts ? [...fonts.entries()][0] : undefined;
  if (!entry) throw new Error('ไม่พบ font resource ในหน้าที่สร้าง');
  const fontKey = entry[0].asString().replace(/^\//, '');

  const stream = doc.context.flateStream(toBytes(build(fontKey)));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return doc.save({ useObjectStreams: false });
}

/**
 * "246/8" written as three tokens: the first two hop with `Td`, the third is
 * placed absolutely in a new text object. The run cannot be collapsed safely,
 * so the native path must decline and the erase path must take over.
 */
export function mixedPlacementPdf(): Promise<Uint8Array> {
  // the hops are the exact advance widths at 12pt Helvetica, so pdf.js reads the
  // three tokens as one continuous run of text — as it does in real documents
  return pageWithOps((f) => `BT
/${f} 12 Tf
1 0 0 1 40 100 Tm
(24) Tj
13.344 0 Td
(6/) Tj
1 0 0 1 63.352 100 Tm
(8) Tj
ET
BT
/${f} 12 Tf
1 0 0 1 120 100 Tm
(Sukhumvit Rd) Tj
ET
`);
}

/**
 * "246/8" in one token, and the rest of the line in a separate text object with
 * its own `Tm`. Nothing trails the edit inside its text object, so "push" has
 * to move that second matrix or nothing moves at all.
 *
 * The neighbour sits well clear of the edit so pdf.js keeps reading it as its
 * own item after the push — otherwise the two merge and the move is invisible
 * to the check rather than absent.
 */
export function separateRunsPdf(): Promise<Uint8Array> {
  return pageWithOps((f) => `BT
/${f} 12 Tf
1 0 0 1 40 100 Tm
(246/8) Tj
ET
BT
/${f} 12 Tf
1 0 0 1 140 100 Tm
(Sukhumvit Rd) Tj
ET
BT
/${f} 12 Tf
1 0 0 1 40 70 Tm
(Bangkok 10230) Tj
ET
`);
}
