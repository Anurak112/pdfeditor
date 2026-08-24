/**
 * Finding, measuring and replacing the images inside a PDF.
 *
 * Compress lives or dies here. Profiling the documents on this machine before
 * writing any of it settled the argument: in the files people actually want
 * smaller, images are 94–100% of the bytes, and a plain re-save returns 0.0%.
 * So the only honest compressor is one that reaches the image streams — and
 * that means knowing which objects are images, how big they are drawn, and how
 * to hand their pixels back once they have been re-encoded.
 *
 * Nothing here encodes anything. Producing JPEG bytes needs a canvas, which a
 * Node test does not have, so the encoder arrives through the context the same
 * way pdf.js does. This module stays pure, and is therefore the part that can
 * be checked against real documents without a browser.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext, PDFDocument } from 'pdf-lib';
import { tokenize } from '../lib/pdf/contentStream';
import type { Matrix } from '../lib/pdf/contentStream';
import type { RecodedImage } from './types';

const latin1 = new TextDecoder('latin1');

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Bytes of any stream, decompressed, or null if we cannot read it. */
export function streamBytes(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    return stream.getContents();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// where each image is drawn
// ---------------------------------------------------------------------------

export interface Placement {
  /** Points on the page, from the matrix in force at the `Do`. */
  widthPt: number;
  heightPt: number;
}

/**
 * Walks the page content and records how large each image is actually drawn.
 *
 * This is what makes a dpi setting mean something. Without it "144 dpi" is
 * decoration: an invoice on this machine carries a 2000x2000 logo that is
 * printed at two inches, and a compressor that only compares pixels to the page
 * size leaves it almost untouched.
 *
 * Only `q`, `Q`, `cm` and `Do` matter, so this is a matrix stack and nothing
 * else. The tokenizer is the editor's — it already handles strings, comments
 * and the unlexable payload of an inline image, which a regex would walk
 * straight into.
 */
export function scanPlacements(doc: PDFDocument): Map<string, Placement> {
  const found = new Map<string, Placement>();
  const ctx = doc.context;

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    for (const part of contentPartsOf(ctx, page.node.Contents())) {
      scanOne(ctx, part, resources ?? null, IDENTITY, found, 0);
    }
  }
  return found;
}

function contentPartsOf(ctx: PDFContext, contents: unknown): Uint8Array[] {
  const parts: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (const ref of contents.asArray()) {
      const stream = ctx.lookup(ref);
      if (stream instanceof PDFStream) {
        const bytes = streamBytes(stream);
        if (bytes) parts.push(bytes);
      }
    }
  } else if (contents instanceof PDFStream) {
    const bytes = streamBytes(contents);
    if (bytes) parts.push(bytes);
  }
  return parts;
}

/** Form XObjects nest, and a document that nests this deep is not worth chasing. */
const MAX_FORM_DEPTH = 6;

function scanOne(
  ctx: PDFContext,
  content: Uint8Array,
  resources: PDFDict | null,
  ctm: Matrix,
  found: Map<string, Placement>,
  depth: number,
): void {
  if (depth > MAX_FORM_DEPTH) return;

  const xobjectsRaw = resources ? ctx.lookup(resources.get(PDFName.of('XObject'))) : null;
  const xobjects = xobjectsRaw instanceof PDFDict ? xobjectsRaw : null;

  const tokens = tokenize(latin1.decode(content));
  const stack: Matrix[] = [];
  let current = ctm;
  let operands: (number | string)[] = [];

  for (const token of tokens) {
    if (token.type === 'number') {
      operands.push(token.value as number);
      continue;
    }
    if (token.type === 'name') {
      operands.push('/' + (token.value as string));
      continue;
    }
    if (token.type !== 'operator') {
      operands = [];
      continue;
    }

    const op = token.value as string;
    if (op === 'q') {
      stack.push(current);
    } else if (op === 'Q') {
      current = stack.pop() ?? current;
    } else if (op === 'cm' && operands.length >= 6) {
      const six = operands.slice(-6);
      if (six.every((v) => typeof v === 'number')) current = multiply(six as Matrix, current);
    } else if (op === 'Do' && xobjects) {
      const name = operands[operands.length - 1];
      if (typeof name === 'string' && name.startsWith('/')) {
        visitXObject(ctx, xobjects, name.slice(1), resources, current, found, depth);
      }
    }
    operands = [];
  }
}

function visitXObject(
  ctx: PDFContext,
  xobjects: PDFDict,
  name: string,
  parentResources: PDFDict | null,
  ctm: Matrix,
  found: Map<string, Placement>,
  depth: number,
): void {
  const ref = xobjects.get(PDFName.of(name));
  if (!(ref instanceof PDFRef)) return;
  const xobject = ctx.lookup(ref);
  if (!(xobject instanceof PDFStream)) return;

  const subtype = xobject.dict.get(PDFName.of('Subtype'));
  const kind = subtype instanceof PDFName ? subtype.asString() : '';

  if (kind === '/Image') {
    // The unit square maps to the image, so the drawn size is the length of the
    // two basis vectors — which stays right for a rotated or flipped image.
    const widthPt = Math.hypot(ctm[0], ctm[1]);
    const heightPt = Math.hypot(ctm[2], ctm[3]);
    const key = keyOf(ref);
    const previous = found.get(key);
    // One image can be drawn several times. The largest placement is the one
    // that sets how much resolution is really needed.
    if (!previous || widthPt * heightPt > previous.widthPt * previous.heightPt) {
      found.set(key, { widthPt, heightPt });
    }
    return;
  }

  if (kind !== '/Form') return;

  let inner = ctm;
  const matrix = xobject.dict.get(PDFName.of('Matrix'));
  if (matrix instanceof PDFArray && matrix.size() === 6) {
    const six = matrix.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
    inner = multiply(six as Matrix, ctm);
  }

  const ownResources = ctx.lookup(xobject.dict.get(PDFName.of('Resources')));
  const bytes = streamBytes(xobject);
  if (bytes) {
    scanOne(
      ctx,
      bytes,
      ownResources instanceof PDFDict ? ownResources : parentResources,
      inner,
      found,
      depth + 1,
    );
  }
}

export function keyOf(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber}`;
}

// ---------------------------------------------------------------------------
// what each image is
// ---------------------------------------------------------------------------

export type ImageColour = 'gray' | 'rgb' | 'cmyk' | 'indexed' | 'other';

export interface ImageEntry {
  ref: PDFRef;
  key: string;
  stream: PDFRawStream;
  width: number;
  height: number;
  bitsPerComponent: number;
  /** The single filter name, or the last of a chain. */
  filter: string;
  colour: ImageColour;
  components: number;
  /** Bytes this image occupies in the file, as stored. */
  storedBytes: number;
  isMask: boolean;
  /** A soft mask or stencil belonging to another image, not drawn on its own. */
  isMaskTarget: boolean;
  /** A /Decode array or colour-key /Mask makes the samples mean something else. */
  hasSampleTricks: boolean;
}

function nameOf(value: unknown): string {
  return value instanceof PDFName ? value.asString() : '';
}

/** Last filter in the chain — the one that decides whether we can read the pixels. */
function filterOf(dict: PDFDict): string {
  const filter = dict.get(PDFName.of('Filter'));
  if (filter instanceof PDFName) return filter.asString();
  if (filter instanceof PDFArray && filter.size() > 0) return nameOf(filter.get(filter.size() - 1));
  return '';
}

function colourOf(ctx: PDFContext, dict: PDFDict): { colour: ImageColour; components: number } {
  const raw = ctx.lookup(dict.get(PDFName.of('ColorSpace')));

  if (raw instanceof PDFName) {
    const name = raw.asString();
    if (name === '/DeviceGray' || name === '/G' || name === '/CalGray') return { colour: 'gray', components: 1 };
    if (name === '/DeviceRGB' || name === '/RGB' || name === '/CalRGB') return { colour: 'rgb', components: 3 };
    if (name === '/DeviceCMYK' || name === '/CMYK') return { colour: 'cmyk', components: 4 };
    // A name that is not a device space refers to the page's ColorSpace
    // resources, which we would have to carry down here to resolve. Counted as
    // unknown rather than guessed at.
    return { colour: 'other', components: 0 };
  }

  if (raw instanceof PDFArray && raw.size() > 0) {
    const family = nameOf(raw.get(0));
    if (family === '/ICCBased') {
      const profile = ctx.lookup(raw.get(1));
      const n = profile instanceof PDFStream ? profile.dict.get(PDFName.of('N')) : null;
      const components = n instanceof PDFNumber ? n.asNumber() : 0;
      if (components === 1) return { colour: 'gray', components: 1 };
      if (components === 3) return { colour: 'rgb', components: 3 };
      if (components === 4) return { colour: 'cmyk', components: 4 };
      return { colour: 'other', components: 0 };
    }
    if (family === '/CalGray') return { colour: 'gray', components: 1 };
    if (family === '/CalRGB' || family === '/Lab') return { colour: 'rgb', components: 3 };
    if (family === '/Indexed' || family === '/I') return { colour: 'indexed', components: 1 };
    return { colour: 'other', components: 0 };
  }

  // No colour space at all is legal for a stencil mask, and meaningless for
  // anything else.
  return { colour: 'other', components: 0 };
}

/**
 * Every image object in the file, with what we know about it.
 *
 * Soft masks are found and then marked rather than dropped: they are images by
 * every structural test, but they carry transparency rather than a picture, and
 * putting one through a lossy encoder puts a halo around whatever it was
 * cutting out.
 */
export function listImages(doc: PDFDocument): ImageEntry[] {
  const ctx = doc.context;
  const maskTargets = new Set<string>();
  const entries: ImageEntry[] = [];

  for (const [, object] of ctx.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const value = object.dict.get(PDFName.of(key));
      if (value instanceof PDFRef) maskTargets.add(keyOf(value));
    }
  }

  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (nameOf(dict.get(PDFName.of('Subtype'))) !== '/Image') continue;

    const width = numberAt(dict, 'Width');
    const height = numberAt(dict, 'Height');
    if (width <= 0 || height <= 0) continue;

    const { colour, components } = colourOf(ctx, dict);
    const isMask = dict.get(PDFName.of('ImageMask'))?.toString() === 'true';
    const decode = dict.get(PDFName.of('Decode'));
    const mask = dict.get(PDFName.of('Mask'));

    entries.push({
      ref,
      key: keyOf(ref),
      stream: object,
      width,
      height,
      bitsPerComponent: numberAt(dict, 'BitsPerComponent'),
      filter: filterOf(dict),
      colour,
      components,
      storedBytes: object.contents.length,
      isMask,
      isMaskTarget: maskTargets.has(keyOf(ref)),
      // A /Decode array inverts or remaps the samples, and a colour-key /Mask
      // names sample ranges to knock out. Both describe the numbers we are
      // about to throw away, so both make re-encoding a colour change.
      hasSampleTricks: decode instanceof PDFArray || mask instanceof PDFArray,
    });
  }

  return entries;
}

function numberAt(dict: PDFDict, key: string): number {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : 0;
}

// ---------------------------------------------------------------------------
// reading the pixels
// ---------------------------------------------------------------------------

/**
 * Undoes a PNG predictor.
 *
 * Producers that write images through a PNG-style pipeline leave `/Predictor
 * 15` behind, and pdf-lib's decoder stops at the inflate. Without this, the
 * three real-world documents tested here with `/Predictor 15` all came back as
 * an error and would have been silently skipped — three-fifths of the images in
 * a company registration certificate.
 */
export function undoPngPredictor(
  data: Uint8Array,
  colours: number,
  columns: number,
  bitsPerComponent: number,
): Uint8Array | null {
  const bpp = Math.max(1, Math.ceil((colours * bitsPerComponent) / 8));
  const rowLength = Math.ceil((colours * bitsPerComponent * columns) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  if (rows <= 0) return null;

  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);

  for (let r = 0; r < rows; r++) {
    const at = r * (rowLength + 1);
    const type = data[at];
    const row = data.subarray(at + 1, at + 1 + rowLength);
    const target = out.subarray(r * rowLength, (r + 1) * rowLength);

    for (let i = 0; i < rowLength; i++) {
      const raw = row[i];
      const left = i >= bpp ? target[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;

      switch (type) {
        case 0: target[i] = raw; break;
        case 1: target[i] = (raw + left) & 0xff; break;
        case 2: target[i] = (raw + up) & 0xff; break;
        case 3: target[i] = (raw + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          target[i] = (raw + best) & 0xff;
          break;
        }
        default:
          // An unknown filter byte means we have lost sync with the rows, and
          // continuing would produce plausible-looking garbage.
          return null;
      }
    }
    previous = target;
  }

  return out;
}

/**
 * The image's samples, one byte per component, or null if we cannot get them.
 *
 * Only 8-bit gray and RGB come back. Everything else — CMYK, indexed palettes,
 * 1-bit stencils, JPEG 2000 — is refused rather than approximated, because a
 * compressor that changes the colours of a logo is worse than one that leaves
 * the file alone.
 */
export function decodeSamples(ctx: PDFContext, entry: ImageEntry): Uint8Array | null {
  if (entry.bitsPerComponent !== 8) return null;
  if (entry.components !== 1 && entry.components !== 3) return null;

  let data: Uint8Array;
  try {
    data = decodePDFRawStream(entry.stream).decode();
  } catch {
    // The one document here that failed to inflate turned out to be encrypted,
    // not exotic — and an encrypted file never reaches this far, because
    // PdfSource refuses it up front and offers Unlock instead. Anything else
    // that will not inflate is a stream we should leave alone.
    return null;
  }

  const parms = ctx.lookup(entry.stream.dict.get(PDFName.of('DecodeParms')));
  const predictor = parms instanceof PDFDict ? numberAt(parms, 'Predictor') : 0;

  if (predictor >= 10) {
    const colours = parms instanceof PDFDict ? numberAt(parms, 'Colors') || entry.components : entry.components;
    const columns = parms instanceof PDFDict ? numberAt(parms, 'Columns') || entry.width : entry.width;
    const bits = parms instanceof PDFDict ? numberAt(parms, 'BitsPerComponent') || 8 : 8;
    const undone = undoPngPredictor(data, colours, columns, bits);
    if (!undone) return null;
    data = undone;
  } else if (predictor === 2) {
    // The TIFF predictor is rare and differs per bit depth; refusing is honest.
    return null;
  }

  const expected = entry.width * entry.height * entry.components;
  if (data.length < expected) return null;
  return data.length === expected ? data : data.subarray(0, expected);
}

// ---------------------------------------------------------------------------
// putting the pixels back
// ---------------------------------------------------------------------------

/**
 * Swaps an image's bytes and fixes its dictionary to match.
 *
 * The dictionary is rebuilt from the entries that still apply rather than
 * patched, because the ones that no longer apply are the dangerous half: a
 * `/DecodeParms` describing a predictor that is gone, or a `/ColorSpace` naming
 * a profile the new bytes were never encoded against, both render as a document
 * that opens and looks wrong.
 */
export function replaceImage(ctx: PDFContext, entry: ImageEntry, recoded: RecodedImage): void {
  const dict = ctx.obj({}) as PDFDict;

  // Carried over: everything that describes the image's role on the page rather
  // than how its bytes are packed.
  for (const key of ['Type', 'Subtype', 'Name', 'SMask', 'Mask', 'Intent', 'Interpolate', 'StructParent']) {
    const value = entry.stream.dict.get(PDFName.of(key));
    if (value !== undefined) dict.set(PDFName.of(key), value);
  }

  dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
  dict.set(PDFName.of('Width'), PDFNumber.of(recoded.width));
  dict.set(PDFName.of('Height'), PDFNumber.of(recoded.height));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.set(
    PDFName.of('ColorSpace'),
    PDFName.of(recoded.components === 1 ? 'DeviceGray' : 'DeviceRGB'),
  );
  dict.set(PDFName.of('Filter'), PDFName.of(recoded.format === 'jpeg' ? 'DCTDecode' : 'FlateDecode'));
  dict.set(PDFName.of('Length'), PDFNumber.of(recoded.bytes.length));

  ctx.assign(entry.ref, PDFRawStream.of(dict, recoded.bytes));
}
