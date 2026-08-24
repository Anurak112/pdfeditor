/**
 * Turning a page's text items back into readable text.
 *
 * pdf.js hands back positioned runs, not lines, and it splits them wherever the
 * PDF happened to change font or spacing — often mid-word. Joining those runs
 * with spaces is the standard mistake and it is catastrophic for Thai, which
 * writes without spaces between words: "ใบวางบิล" comes out as "ใ บ ว า ง บิ ล"
 * and is neither readable nor searchable.
 *
 * So runs are grouped by baseline and joined by measured distance instead. A
 * space appears where the page actually left a gap, and nowhere else.
 */
import type { PageText, PdfTextItem } from '../lib/pdf/textExtract';

export interface TextFlowOptions {
  /** Keep the page's own line breaks, or run each paragraph together. */
  flow: 'keep-lines' | 'paragraphs';
  /** Write a marker between pages. */
  pageSeparator: boolean;
}

/**
 * A gap wider than this fraction of the font size is a real space.
 *
 * Too low and Thai gains spaces it never had; too high and English loses the
 * ones it did. A quarter of the em is comfortably inside both margins for the
 * documents this handles.
 */
const SPACE_RATIO = 0.25;

/** Items on the same baseline, within a fraction of the font size. */
function groupIntoLines(items: PdfTextItem[]): PdfTextItem[][] {
  const usable = items.filter((i) => i.text.length > 0);
  if (usable.length === 0) return [];

  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];

  for (const item of sorted) {
    const line = lines[lines.length - 1];
    const tolerance = Math.max(1, item.fontSize * 0.4);
    if (line && Math.abs(line[0].y - item.y) <= tolerance) line.push(item);
    else lines.push([item]);
  }

  for (const line of lines) line.sort((a, b) => a.x - b.x);
  return lines;
}

function joinLine(line: PdfTextItem[]): string {
  let out = '';
  let penX: number | null = null;

  for (const item of line) {
    if (penX !== null) {
      const gap = item.x - penX;
      // Only a measured gap becomes a space. Runs that merely abut — which is
      // how a Thai word arrives, split across several items — are joined.
      if (gap > item.fontSize * SPACE_RATIO) out += ' ';
    }
    out += item.text;
    penX = item.x + item.width;
  }

  return out.replace(/\s+$/, '');
}

/** One page's text, as lines. */
export function linesOfPage(page: PageText): string[] {
  return groupIntoLines(page.items).map(joinLine).filter((l) => l.length > 0);
}

/** Whole document, ready to write to a .txt file. */
export function textOfPages(pages: PageText[], options: TextFlowOptions): string {
  const chunks: string[] = [];

  for (const page of pages) {
    const lines = linesOfPage(page);
    if (options.pageSeparator && chunks.length > 0) {
      chunks.push(`\n--- ${page.page} ---\n`);
    }
    if (lines.length === 0) continue;

    if (options.flow === 'paragraphs') {
      // A blank line ends a paragraph; single breaks inside one are joined.
      // Thai again: joined with nothing, not with a space.
      chunks.push(lines.join('\n').replace(/([^\n])\n(?!\n)/g, '$1'));
    } else {
      chunks.push(lines.join('\n'));
    }
  }

  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
