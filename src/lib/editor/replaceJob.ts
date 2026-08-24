/**
 * Turning "find this text, write that instead" into concrete edits.
 *
 * One document, any number of pages, any number of occurrences. Both the
 * single-file editor and the batch runner go through here, so a batch run is
 * never a second implementation that can drift from what the preview showed.
 */
import { extractPageText, findOnPage, type PageText } from '../pdf/textExtract';
import { buildEditedPdf, type OverflowMode, type Replacement, type ReplacementReport } from '../pdf/exporter';
import { sampleColors } from '../pdf/sample';
import type { SampleTarget } from '../pdf/sample';
// type-only: pdfjs.ts pulls in the worker source, which only a bundler can resolve
import type { PdfDocument } from '../pdf/pdfjs';

/**
 * Hands back a rasterised page so patch colours can be read off real pixels.
 *
 * Typed as what sampling actually needs rather than as a DOM-rendered page, so
 * a worker can satisfy it with an OffscreenCanvas. The editor's RenderedPage
 * still fits — it just carries more than is required.
 */
export type InkSampler = (pageNumber: number) => Promise<SampleTarget | null>;

const DEFAULT_COLORS = { background: { r: 1, g: 1, b: 1 }, text: { r: 0, g: 0, b: 0 } };

/**
 * Build one Replacement per occurrence of `find` on the given pages.
 *
 * `sampler` is optional: the colours it provides only matter for the overlay
 * fallback, so a headless caller can leave it out and still get correct native
 * edits — the exporter reports which method it ended up using either way.
 */
export async function collectReplacements(
  pages: PageText[],
  find: string,
  replace: string,
  sampler?: InkSampler,
  overflow: OverflowMode = 'squeeze',
): Promise<Replacement[]> {
  if (!find) return [];
  const out: Replacement[] = [];

  for (const page of pages) {
    const hits = findOnPage(page, find);
    if (hits.length === 0) continue;

    const rendered = sampler ? await sampler(page.page) : null;

    hits.forEach((hit, i) => {
      const colors = rendered
        ? sampleColors(rendered, {
            x: hit.x,
            y: hit.item.y + hit.item.descent * hit.item.fontSize,
            width: hit.width,
            height: (hit.item.ascent - hit.item.descent) * hit.item.fontSize,
          })
        : DEFAULT_COLORS;

      out.push({
        id: `p${page.page}-${i}-${find}-${replace}`,
        page: page.page,
        find,
        replace,
        ordinal: hit.ordinal,
        x: hit.x,
        y: hit.item.y,
        width: hit.width,
        fontSize: hit.item.fontSize,
        ascent: hit.item.ascent,
        descent: hit.item.descent,
        gapRight: hit.gapRight,
        itemText: hit.item.text,
        itemWidth: hit.item.width,
        background: colors.background,
        textColor: colors.text,
        overflow,
      });
    });
  }
  return out;
}

/** Read every page's text layer once. */
export async function readAllPages(doc: PdfDocument): Promise<PageText[]> {
  const pages: PageText[] = [];
  const count = (doc as unknown as { numPages: number }).numPages;
  for (let n = 1; n <= count; n++) pages.push(await extractPageText(doc, n));
  return pages;
}

export interface DocumentJobResult {
  bytes: Uint8Array;
  reports: ReplacementReport[];
  /** How many occurrences were found and edited. */
  hits: number;
  /** True when the document had no text layer at all — a scan, most likely. */
  scanned: boolean;
}

/**
 * Replace every occurrence in one already-loaded document.
 *
 * The caller supplies the pdf.js document because loading differs by host: the
 * app hands in a bundler-built pdf.js, the test harness the legacy Node build.
 */
export async function replaceInDocument(
  originalBytes: Uint8Array,
  doc: PdfDocument,
  find: string,
  replace: string,
  sampler?: InkSampler,
  overflow: OverflowMode = 'squeeze',
): Promise<DocumentJobResult> {
  const pages = await readAllPages(doc);
  const scanned = pages.every((p) => p.items.length === 0);

  const replacements = await collectReplacements(pages, find, replace, sampler, overflow);
  if (replacements.length === 0) {
    return { bytes: originalBytes, reports: [], hits: 0, scanned };
  }

  const { bytes, reports } = await buildEditedPdf(originalBytes, replacements);
  return { bytes, reports, hits: replacements.length, scanned };
}
