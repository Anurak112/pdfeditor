/**
 * Pull text out of a rendered page together with the geometry we need to edit
 * it: baseline origin, advance width and font size, all in PDF user space
 * (origin bottom-left, y up) — the same space pdf-lib draws in.
 */
import type { PdfDocument } from './pdfjs';

export interface PdfTextItem {
  /** 0-based position in the page reading order. */
  index: number;
  /** 1-based page number. */
  page: number;
  text: string;
  /** Baseline origin, PDF user space. */
  x: number;
  y: number;
  /** Advance width, PDF user space. */
  width: number;
  fontSize: number;
  fontName: string;
  ascent: number;
  descent: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export async function extractPageText(doc: PdfDocument, pageNumber: number): Promise<PageText> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { ascent?: number; descent?: number }>;

  const items: PdfTextItem[] = [];
  for (const raw of content.items) {
    const item = raw as { str?: string; transform?: number[]; width?: number; fontName?: string };
    if (typeof item.str !== 'string' || item.str.length === 0) continue;
    const t = item.transform;
    if (!t) continue;
    const style = styles?.[item.fontName ?? ''] ?? {};
    items.push({
      index: items.length,
      page: pageNumber,
      text: item.str,
      x: t[4],
      y: t[5],
      width: item.width ?? 0,
      fontSize: Math.hypot(t[0], t[1]) || Math.abs(t[3]) || 0,
      fontName: item.fontName ?? '',
      ascent: style.ascent ?? 0.9,
      descent: style.descent ?? -0.25,
    });
  }

  return { page: pageNumber, width: viewport.width, height: viewport.height, items };
}

export interface TextHit {
  item: PdfTextItem;
  /** Character offset of the needle inside item.text. */
  offset: number;
  /** How many earlier hits of the same needle exist on this page in the same font. */
  ordinal: number;
  /** Estimated x of the needle's first glyph, PDF user space. */
  x: number;
  /** Estimated advance width of the needle itself. */
  width: number;
  /** Free space to the right before the next item on the same line, user space. */
  gapRight: number;
}

/**
 * Find every occurrence of `needle` on a page.
 *
 * When the needle is only part of a text item, its x/width are apportioned from
 * the item's advance width. That is an estimate, used for the highlight box and
 * the overlay fallback; the native path works off exact glyph codes instead.
 */
export function findOnPage(pageText: PageText, needle: string): TextHit[] {
  if (!needle) return [];
  const hits: TextHit[] = [];

  for (const item of pageText.items) {
    let from = 0;
    for (;;) {
      const at = item.text.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;

      const perChar = item.text.length > 0 ? item.width / item.text.length : 0;
      const partial = needle.length < item.text.length;
      const x = partial ? item.x + perChar * at : item.x;
      const width = partial ? perChar * needle.length : item.width;

      const ordinal = hits.filter((h) => h.item.fontName === item.fontName).length;
      hits.push({ item, offset: at, ordinal, x, width, gapRight: gapAfter(pageText, item, x + width) });
    }
  }
  return hits;
}

/**
 * Distance from `rightEdge` to the next item sharing this baseline.
 * Goes negative when the text has grown into its neighbour, so callers can
 * detect a collision rather than silently missing it.
 */
function gapAfter(pageText: PageText, item: PdfTextItem, rightEdge: number): number {
  const tolerance = Math.max(1, item.fontSize * 0.3);
  let nearest = Infinity;
  for (const other of pageText.items) {
    if (other === item) continue;
    if (Math.abs(other.y - item.y) > tolerance) continue;
    if (other.x <= item.x + 0.01) continue;
    if (other.text.trim() === '') continue;
    nearest = Math.min(nearest, other.x - rightEdge);
  }
  return nearest;
}
