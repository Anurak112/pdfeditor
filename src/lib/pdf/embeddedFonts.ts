/**
 * Read the fonts a page already embeds, so replacement text can be drawn with
 * the *original* typeface instead of a look-alike.
 *
 * Two families are understood, because between them they cover what document
 * generators actually emit:
 *
 *  · Type0 / Identity-H — two bytes per glyph, the code IS the glyph id.
 *    LibreOffice, Word-to-PDF and Stripe write these.
 *  · simple TrueType / Type1 — one byte per glyph, mapped through /ToUnicode or
 *    an encoding table. jsPDF, ReportLab and most Thai invoice generators write
 *    these; until they were supported such files could only be patched over.
 *
 * Both end up behind the same interface, so the editing core does not care
 * which one it is holding — only `bytesPerCode` differs.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { Font as StandardFont, FontNames } from '@pdf-lib/standard-fonts';
import { parseToUnicode, parseWidths } from './cmap';
import { baseEncodingTable, glyphNameForUnicode, unicodeForGlyphName } from './encodings';

export interface EmbeddedFont {
  /** Resource key on the page, e.g. "F4" (no leading slash). */
  resourceName: string;
  /** /BaseFont, e.g. "Inter-Regular". */
  baseFont: string;
  /** 2 for Type0/Identity-H, 1 for simple TrueType/Type1 fonts. */
  bytesPerCode: 1 | 2;
  /** unicode -> character code (a CID for Type0, a byte for simple fonts) */
  cmap: Map<string, number>;
  /** code -> width in 1/1000 em */
  widths: Map<number, number>;
  defaultWidth: number;
  /** code -> unicode (built by inverting cmap) */
  reverse: Map<number, string>;
  /** All characters encodable? */
  canEncode(text: string): boolean;
  /** Text -> hex string of character codes, or null if a glyph is missing. */
  encode(text: string): string | null;
  /** Advance width of `text` at `size` pt, or null if unencodable. */
  widthOf(text: string, size: number): number | null;
  /** Advance width of one character at `size` pt. */
  charWidth(ch: string, size: number): number;
}

const latin1 = new TextDecoder('latin1');

/** pdf-lib's typed lookup throws on a missing key; this reports it as absent. */
function maybe<T>(dict: PDFDict | undefined, key: string, type: unknown): T | undefined {
  if (!dict) return undefined;
  try {
    return dict.lookup(PDFName.of(key), type as never) as T;
  } catch {
    return undefined;
  }
}

function nameOf(dict: PDFDict | undefined, key: string): string | undefined {
  const raw = dict?.get(PDFName.of(key));
  return raw ? raw.toString().replace(/^\//, '') : undefined;
}

function numberOf(dict: PDFDict | undefined, key: string): number | undefined {
  const raw = dict?.get(PDFName.of(key));
  return raw instanceof PDFNumber ? raw.asNumber() : undefined;
}

function numbersOf(arr: PDFArray | undefined): Array<number | number[]> {
  if (!arr) return [];
  const out: Array<number | number[]> = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i);
    if (v instanceof PDFArray) {
      const inner: number[] = [];
      for (let k = 0; k < v.size(); k++) {
        const n = v.lookup(k);
        inner.push(n instanceof PDFNumber ? n.asNumber() : 0);
      }
      out.push(inner);
    } else if (v instanceof PDFNumber) {
      out.push(v.asNumber());
    }
  }
  return out;
}

/** Read /ToUnicode into unicode -> code, or null when the font has none. */
function readToUnicode(fontDict: PDFDict): Map<string, number> | null {
  const stream = fontDict.lookup(PDFName.of('ToUnicode')) as { contents?: unknown } | undefined;
  if (!stream?.contents) return null;
  try {
    const map = parseToUnicode(latin1.decode(decodePDFRawStream(stream as never).decode()));
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

type FontCore = Omit<EmbeddedFont, 'reverse' | 'canEncode' | 'encode' | 'widthOf' | 'charWidth'>;

function finalize(partial: FontCore): EmbeddedFont {
  const { cmap, widths, defaultWidth, bytesPerCode } = partial;
  const reverse = new Map<number, string>();
  for (const [uni, code] of cmap) if (!reverse.has(code)) reverse.set(code, uni);
  const hexDigits = bytesPerCode * 2;

  return {
    ...partial,
    reverse,
    canEncode: (text) => [...text].every((ch) => cmap.has(ch)),
    encode(text) {
      let hex = '';
      for (const ch of text) {
        const code = cmap.get(ch);
        if (code === undefined) return null;
        hex += code.toString(16).padStart(hexDigits, '0').toUpperCase();
      }
      return hex;
    },
    charWidth(ch, size) {
      const code = cmap.get(ch);
      return ((code !== undefined ? widths.get(code) ?? defaultWidth : defaultWidth) / 1000) * size;
    },
    widthOf(text, size) {
      let total = 0;
      for (const ch of text) {
        const code = cmap.get(ch);
        if (code === undefined) return null;
        total += widths.get(code) ?? defaultWidth;
      }
      return (total / 1000) * size;
    },
  };
}

/** Type0 with Identity-H: CIDs are glyph ids, widths live in the descendant /W. */
function readType0(resourceName: string, fd: PDFDict): EmbeddedFont | null {
  if (nameOf(fd, 'Encoding') !== 'Identity-H') return null;
  const cmap = readToUnicode(fd);
  if (!cmap) return null;

  const descendant = maybe<PDFArray>(fd, 'DescendantFonts', PDFArray)?.lookup(0, PDFDict);
  const widths = parseWidths(numbersOf(maybe<PDFArray>(descendant, 'W', PDFArray)));

  return finalize({
    resourceName,
    baseFont: (nameOf(fd, 'BaseFont') ?? '').replace(/^[A-Z]{6}\+/, ''),
    bytesPerCode: 2,
    cmap,
    widths,
    defaultWidth: numberOf(descendant, 'DW') ?? 1000,
  });
}

/**
 * Simple TrueType / Type1: one byte per glyph.
 *
 * Reading direction (code -> unicode) prefers /ToUnicode, then the encoding
 * table patched by /Differences. Widths come from /FirstChar + /Widths, or from
 * the standard-14 metrics when the font is one of those and carries no array.
 */
function readSimple(resourceName: string, fd: PDFDict): EmbeddedFont | null {
  const baseFont = (nameOf(fd, 'BaseFont') ?? '').replace(/^[A-Z]{6}\+/, '');

  // code -> unicode, weakest source first so better ones overwrite
  const codeToUni = new Map<number, string>();

  const encodingName = nameOf(fd, 'Encoding');
  const encodingDict = maybe<PDFDict>(fd, 'Encoding', PDFDict);
  const symbolic = /Symbol|ZapfDingbats/i.test(baseFont);
  if (!symbolic) {
    const base = baseEncodingTable(encodingDict ? nameOf(encodingDict, 'BaseEncoding') : encodingName);
    for (const [code, uni] of base) codeToUni.set(code, uni);
  }

  // /Differences: [ code /name /name ... code /name ... ]
  const differences = maybe<PDFArray>(encodingDict, 'Differences', PDFArray);
  if (differences) {
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const entry = differences.lookup(i);
      if (entry instanceof PDFNumber) {
        code = entry.asNumber();
      } else if (entry instanceof PDFName) {
        const uni = unicodeForGlyphName(entry.asString().replace(/^\//, ''));
        if (uni) codeToUni.set(code, uni);
        else codeToUni.delete(code);
        code++;
      }
    }
  }

  // /ToUnicode wins: it is what the producer itself says the bytes mean
  const fromToUnicode = readToUnicode(fd);
  if (fromToUnicode) {
    for (const [uni, code] of fromToUnicode) if (code <= 0xff) codeToUni.set(code, uni);
  }
  if (codeToUni.size === 0) return null;

  const cmap = new Map<string, number>();
  for (const [code, uni] of codeToUni) if (!cmap.has(uni)) cmap.set(uni, code);

  const widths = new Map<number, number>();
  const first = numberOf(fd, 'FirstChar');
  const widthArray = maybe<PDFArray>(fd, 'Widths', PDFArray);
  if (widthArray && first !== undefined) {
    for (let i = 0; i < widthArray.size(); i++) {
      const w = widthArray.lookup(i);
      if (w instanceof PDFNumber) widths.set(first + i, w.asNumber());
    }
  }

  const descriptor = maybe<PDFDict>(fd, 'FontDescriptor', PDFDict);
  let defaultWidth = numberOf(descriptor, 'MissingWidth') ?? 0;

  if (widths.size === 0) {
    // an unembedded standard-14 font — its metrics are known, not guessed
    const metrics = loadStandardMetrics(baseFont);
    if (!metrics) return null;
    for (const [code, uni] of codeToUni) {
      const glyphName = glyphNameForUnicode(uni);
      if (!glyphName) continue;
      try {
        const w = metrics.getWidthOfGlyph(glyphName);
        if (typeof w === 'number' && w > 0) widths.set(code, w);
      } catch {
        /* glyph absent from the metrics — leave it on the default width */
      }
    }
    if (widths.size === 0) return null;
    if (defaultWidth === 0) defaultWidth = 500;
  }

  return finalize({ resourceName, baseFont, bytesPerCode: 1, cmap, widths, defaultWidth });
}

type StandardMetrics = ReturnType<typeof StandardFont.load>;
const standardMetricsCache = new Map<string, StandardMetrics | null>();

/** Metrics for one of the 14 fonts every viewer ships, if `baseFont` is one. */
function loadStandardMetrics(baseFont: string): StandardMetrics | null {
  const cached = standardMetricsCache.get(baseFont);
  if (cached !== undefined) return cached;

  const known = Object.values(FontNames) as string[];
  const wanted = baseFont.replace(/,/g, '-').toLowerCase();
  const id =
    known.find((n) => n.toLowerCase() === wanted) ??
    known.find((n) => n.toLowerCase() === wanted.replace('bolditalic', 'boldoblique')) ??
    known.find((n) => n.toLowerCase() === wanted.replace('italic', 'oblique'));

  let metrics: StandardMetrics | null = null;
  if (id) {
    try {
      metrics = StandardFont.load(id as never);
    } catch {
      metrics = null;
    }
  }
  standardMetricsCache.set(baseFont, metrics);
  return metrics;
}

export function collectEmbeddedFonts(page: PDFPage): EmbeddedFont[] {
  const found: EmbeddedFont[] = [];
  const fontsDict = maybe<PDFDict>(page.node.Resources() ?? undefined, 'Font', PDFDict);
  if (!fontsDict) return found;

  for (const [key] of fontsDict.entries()) {
    let font: EmbeddedFont | null = null;
    try {
      const resourceName = key.asString().replace(/^\//, '');
      const fd = maybe<PDFDict>(fontsDict, resourceName, PDFDict);
      if (!fd) continue;
      const subtype = nameOf(fd, 'Subtype');
      if (subtype === 'Type0') font = readType0(resourceName, fd);
      else if (subtype === 'TrueType' || subtype === 'Type1' || subtype === 'MMType1') font = readSimple(resourceName, fd);
    } catch {
      font = null;
    }
    if (font) found.push(font);
  }
  return found;
}

/**
 * Pick the embedded font that actually rendered `sampleText`.
 *
 * The give-away is width: re-measuring the original string with the right font
 * reproduces the width pdf.js measured off the page, to ~0.001pt. That doubles
 * as a self-check — a bad match shows up as a large error instead of silently
 * drawing the wrong typeface.
 */
export function matchFontByWidth(
  fonts: EmbeddedFont[],
  sampleText: string,
  sampleWidth: number,
  fontSize: number,
  mustEncode: string,
): { font: EmbeddedFont; error: number } | null {
  let best: { font: EmbeddedFont; error: number } | null = null;
  for (const font of fonts) {
    const w = font.widthOf(sampleText, fontSize);
    if (w === null || !font.canEncode(mustEncode)) continue;
    const error = Math.abs(w - sampleWidth);
    if (!best || error < best.error) best = { font, error };
  }
  return best;
}
