/**
 * Turn the original bytes + a list of replacements into a new PDF.
 *
 * Strategies, tried in this order per replacement:
 *
 *  1. native   — rewrite the glyph codes where they sit in the content stream.
 *                The document really says the new text: nothing hidden under a
 *                patch, clean text layer, and the typeface is by definition the
 *                original one. Needs the same number of characters.
 *  2. erase    — delete the old glyphs from the stream, then draw the new text
 *                on top. Used when the length changes. Still leaves no ghost
 *                text behind, and needs no patch rectangle.
 *  3. overlay  — paint over the old text and draw on top. The universal
 *                fallback; the original string stays in the text layer, which
 *                the UI says out loud.
 */
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  beginText,
  decodePDFRawStream,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  showText,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { collectEmbeddedFonts, matchFontByWidth, type EmbeddedFont } from './embeddedFonts';
import {
  applyEdits,
  findInGlyphs,
  indexGlyphs,
  planEraseGlyphs,
  planNativeEdit,
  planShiftAfter,
  tokenize,
  type Edit,
  type FontLookup,
  type GlyphSlot,
  type NativePlan,
  type NativeMatch,
  type Token,
} from './contentStream';
import type { RGB } from './render';

/**
 * What to do when the new text needs more room than the old text had.
 *  · squeeze — tighten the replacement so the line keeps its shape (default)
 *  · push    — keep the letters at full width and move the rest of the line right
 */
export type OverflowMode = 'squeeze' | 'push';

export interface Replacement {
  id: string;
  /** 1-based. */
  page: number;
  find: string;
  replace: string;
  /** Which occurrence of `find` on the page, counted within the same font. */
  ordinal: number;
  /** Baseline origin of the matched text, PDF user space. */
  x: number;
  y: number;
  /** Advance width of the matched text, PDF user space. */
  width: number;
  fontSize: number;
  ascent: number;
  descent: number;
  /** Room to the next item on the same line, PDF user space (Infinity if none). */
  gapRight: number;
  /** Full text of the containing item — used to identify the original font. */
  itemText: string;
  /** Advance width of that whole item. */
  itemWidth: number;
  background: RGB;
  textColor: RGB;
  /** Defaults to 'squeeze'. */
  overflow?: OverflowMode;
}

export type EditMethod = 'native' | 'erase' | 'overlay';

export interface ReplacementReport {
  id: string;
  page: number;
  find: string;
  replace: string;
  method: EditMethod;
  /** Which embedded font was used, or the fallback's name. */
  fontName: string;
  /** How closely the chosen font reproduced the original width, in points. */
  fontWidthError: number | null;
  /** Below 1 when the new text had to be tightened to fit. */
  fitScale: number;
  /** How far the rest of the line was moved right, in points (0 when nothing moved). */
  pushed: number;
  /** True when the original string is gone from the text layer too. */
  originalRemoved: boolean;
  notes: string[];
}

export interface BuildResult {
  bytes: Uint8Array;
  reports: ReplacementReport[];
}

const latin1 = new TextDecoder('latin1');
const THAI = /[฀-๿]/;

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

let thaiFontBytes: Uint8Array | null = null;
async function getThaiFont(): Promise<Uint8Array | null> {
  if (thaiFontBytes) return thaiFontBytes;
  try {
    // dynamic so this module still loads outside a bundler (tests, node)
    const mod = await import('../../assets/NotoSansThai-Regular.ttf?url');
    const res = await fetch((mod as { default: string }).default);
    thaiFontBytes = new Uint8Array(await res.arrayBuffer());
    return thaiFontBytes;
  } catch {
    return null;
  }
}

/** Every content stream of a page, as refs we can reassign after editing. */
function contentStreamRefs(page: PDFPage): PDFRef[] {
  const ctx = page.doc.context;
  const entry = page.node.get(PDFName.of('Contents'));
  const refs: PDFRef[] = [];

  const collectArray = (arr: PDFArray) => {
    for (let i = 0; i < arr.size(); i++) {
      const item = arr.get(i);
      if (item instanceof PDFRef) refs.push(item);
    }
  };

  if (entry instanceof PDFRef) {
    const resolved = ctx.lookup(entry);
    if (resolved instanceof PDFArray) collectArray(resolved);
    else refs.push(entry);
  } else if (entry instanceof PDFArray) {
    collectArray(entry);
  }
  return refs;
}

interface LiveStream { ref: PDFRef; text: string; dirty: boolean }

function readStreams(page: PDFPage): LiveStream[] {
  const ctx = page.doc.context;
  const out: LiveStream[] = [];
  for (const ref of contentStreamRefs(page)) {
    try {
      const stream = ctx.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      out.push({ ref, text: latin1.decode(decodePDFRawStream(stream).decode()), dirty: false });
    } catch {
      /* not a stream we can read — skip it */
    }
  }
  return out;
}

function writeStreams(page: PDFPage, streams: LiveStream[]) {
  const ctx = page.doc.context;
  for (const s of streams) {
    if (!s.dirty) continue;
    ctx.assign(s.ref, ctx.flateStream(toBytes(s.text)));
    s.dirty = false;
  }
}

interface Located { stream: LiveStream; tokens: Token[]; slots: GlyphSlot[]; match: NativeMatch; total: number }

/**
 * Find the glyph run in the page's content streams that this replacement targets.
 *
 * Several copies of the same word can sit on one page, so the run is chosen by
 * where it is drawn — the walker knows each glyph's position, and pdf.js told
 * the caller where the highlight was. Counting occurrences instead used to pick
 * the wrong copy whenever the two disagreed on ordering.
 */
function locateGlyphRun(
  streams: LiveStream[],
  rep: Replacement,
  font: EmbeddedFont,
  fontFor: FontLookup,
): Located | null {
  const found: Array<Omit<Located, 'total'>> = [];
  for (const stream of streams) {
    const tokens = tokenize(stream.text);
    const slots = indexGlyphs(tokens, fontFor);
    for (const match of findInGlyphs(slots, font, rep.find)) found.push({ stream, tokens, slots, match });
  }
  if (found.length === 0) return null;

  // tolerance scales with type size: the highlight's x is apportioned from the
  // item's advance width, so it is close but not exact for mid-item matches
  const tolerance = Math.max(2, rep.fontSize * 0.6);
  let best: { item: Omit<Located, 'total'>; distance: number } | null = null;
  for (const item of found) {
    const { x, y } = item.match;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const distance = Math.hypot(x - rep.x, y - rep.y);
    if (!best || distance < best.distance) best = { item, distance };
  }

  const chosen = best && best.distance <= tolerance ? best.item : found[Math.min(rep.ordinal, found.length - 1)];
  return { ...chosen, total: found.length };
}

/** Room available in the stream's own text-space units, if there is a limit. */
function roomInTextSpace(rep: Replacement, match: NativeMatch): number | undefined {
  if (!Number.isFinite(rep.gapRight) || rep.fontSize <= 0 || match.fontSize <= 0) return undefined;
  const margin = rep.fontSize * 0.15;
  const roomUser = Math.max(rep.width, rep.width + rep.gapRight - margin);
  return (roomUser * match.fontSize) / rep.fontSize;
}

/** Paint the replacement text at the original baseline. */
async function drawText(
  pdfDoc: PDFDocument,
  page: PDFPage,
  rep: Replacement,
  font: EmbeddedFont | null,
  fallbackCache: Map<string, PDFFont>,
  coverFirst: boolean,
): Promise<{ fitScale: number; fontName: string | null; notes: string[] }> {
  const notes: string[] = [];
  const size = rep.fontSize;

  let newWidth: number | null = font ? font.widthOf(rep.replace, size) : null;
  let embedded: PDFFont | null = null;
  let fontName: string | null = null;

  if (newWidth === null) {
    // the original font cannot spell the replacement — bring our own
    const needsThai = THAI.test(rep.replace);
    const key = needsThai ? 'noto-thai' : 'helvetica';
    let cached = fallbackCache.get(key);
    if (!cached) {
      if (needsThai) {
        const bytes = await getThaiFont();
        if (!bytes) throw new Error('โหลดฟอนต์ไทยสำรองไม่สำเร็จ — ลองใช้ข้อความที่ฟอนต์เดิมมีอยู่');
        pdfDoc.registerFontkit(fontkit);
        cached = await pdfDoc.embedFont(bytes, { subset: true });
      } else {
        cached = await pdfDoc.embedFont(StandardFonts.Helvetica);
      }
      fallbackCache.set(key, cached);
    }
    embedded = cached;
    fontName = needsThai ? 'Noto Sans Thai (สำรอง)' : 'Helvetica (สำรอง)';
    newWidth = embedded.widthOfTextAtSize(rep.replace, size);
    notes.push('ฟอนต์เดิมไม่มีตัวอักษรที่ต้องการ จึงฝังฟอนต์สำรอง');
  }

  if (coverFirst) {
    // patch box = the full em box of the original, so no ink can peek out
    const pad = size * 0.04;
    page.drawRectangle({
      x: rep.x - pad,
      y: rep.y + rep.descent * size - pad,
      width: Math.max(rep.width, newWidth) + pad * 2,
      height: (rep.ascent - rep.descent) * size + pad * 2,
      color: rgb(rep.background.r, rep.background.g, rep.background.b),
    });
  }

  // squeeze rather than overflow into whatever sits to the right
  const margin = size * 0.15;
  const room = Number.isFinite(rep.gapRight) ? Math.max(rep.width, rep.width + rep.gapRight - margin) : Infinity;
  const squeeze = newWidth > room && newWidth > 0 ? (room / newWidth) * 100 : 100;
  if (squeeze < 99.9) notes.push('บีบตัวอักษรเหลือ ' + Math.round(squeeze) + '% เพื่อไม่ให้ชนข้อความถัดไป');

  page.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(rep.textColor.r, rep.textColor.g, rep.textColor.b),
    beginText(),
    setCharacterSqueeze(squeeze),
    setFontAndSize(embedded ? embedded.name : font!.resourceName, size),
    moveText(rep.x, rep.y),
    embedded ? showText(embedded.encodeText(rep.replace)) : showText(PDFHexString.of(font!.encode(rep.replace)!)),
    endText(),
    popGraphicsState(),
  );

  return { fitScale: squeeze / 100, fontName, notes };
}

interface NativeAttempt {
  plan: NativePlan;
  /** Edits that move the rest of the line right; empty unless something moved. */
  shiftEdits: Edit[];
  /** Points the following text actually moved — 0 when nothing did. */
  pushedBy: number;
  notes: string[];
}

/**
 * Rewrite the run in place, honouring the user's choice for text that grew.
 *
 * "Push" only works when there is something to push: text placed with its own
 * `Tm` further along the line. Plenty of documents place the rest of the line
 * relative to the pen (or have nothing to the right at all), and then pushing
 * would just let the new text run into whatever sits there. In that case this
 * falls back to squeezing and says so, rather than reporting a push that never
 * happened.
 */
function planNativeWithOverflow(
  rep: Replacement,
  located: Located,
  font: EmbeddedFont,
): NativeAttempt | { error: string } {
  const room = roomInTextSpace(rep, located.match);
  const pushing = rep.overflow === 'push';

  const squeeze = () => planNativeEdit(
    located.tokens, located.slots, located.match, font, rep.replace, room, { absorbDrift: true },
  );

  if (!pushing) {
    const plan = squeeze();
    return 'error' in plan ? plan : { plan, shiftEdits: [], pushedBy: 0, notes: [] };
  }

  const plan = planNativeEdit(
    located.tokens, located.slots, located.match, font, rep.replace, undefined, { absorbDrift: false },
  );
  if ('error' in plan) return plan;

  const grew = plan.newAdvance - plan.originalAdvance;
  if (grew <= 1e-6) {
    // it did not get wider, so there is nothing to make room for
    return { plan, shiftEdits: [], pushedBy: 0, notes: [] };
  }

  const shift = planShiftAfter(
    located.tokens, located.slots, located.match, grew, located.match.x + plan.originalAdvance,
  );
  // text trailing inside the same text object moves with the pen on its own,
  // because this plan deliberately did not absorb the width difference
  if (shift.edits.length > 0 || shift.trailing > 0) {
    return { plan, shiftEdits: shift.edits, pushedBy: grew, notes: [] };
  }

  // nothing moved at all. Is that fine (empty space to the right) or a collision?
  if (room !== undefined && plan.newAdvance > room) {
    const fallback = squeeze();
    if (!('error' in fallback)) {
      return {
        plan: fallback,
        shiftEdits: [],
        pushedBy: 0,
        notes: ['ไฟล์นี้ดันข้อความถัดไปไม่ได้ (ข้อความข้าง ๆ ไม่ได้วางแบบที่เลื่อนได้) จึงบีบให้พอดีแทน'],
      };
    }
  }

  return {
    plan,
    shiftEdits: [],
    pushedBy: 0,
    notes: ['ไม่มีข้อความในบรรทัดเดียวกันที่ต้องดัน — ข้อความใหม่ยาวขึ้น ' + grew.toFixed(2) + ' pt ในที่ว่างเดิม'],
  };
}

export async function buildEditedPdf(originalBytes: Uint8Array, replacements: Replacement[]): Promise<BuildResult> {
  const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true, updateMetadata: false });
  const reports: ReplacementReport[] = [];
  const fallbackCache = new Map<string, PDFFont>();

  const byPage = new Map<number, Replacement[]>();
  for (const rep of replacements) {
    if (!byPage.has(rep.page)) byPage.set(rep.page, []);
    byPage.get(rep.page)!.push(rep);
  }

  for (const [pageNumber, reps] of byPage) {
    const page = pdfDoc.getPage(pageNumber - 1);
    const embeddedFonts = collectEmbeddedFonts(page);
    // fonts we could not read fall back to 2-byte codes of unknown width:
    // we never rewrite those, so only their neighbours' positions get fuzzy
    const fontFor: FontLookup = (res) => {
      const font = embeddedFonts.find((f) => f.resourceName === res);
      if (!font) return null;
      return {
        bytesPerCode: font.bytesPerCode,
        widthOfCode: (code) => font.widths.get(code) ?? font.defaultWidth,
      };
    };
    const streams = readStreams(page);
    const pending: Array<{ rep: Replacement; font: EmbeddedFont | null; report: ReplacementReport; erased: boolean }> = [];

    for (const rep of reps) {
      const fontMatch = matchFontByWidth(embeddedFonts, rep.itemText, rep.itemWidth, rep.fontSize, rep.replace);
      const report: ReplacementReport = {
        id: rep.id,
        page: rep.page,
        find: rep.find,
        replace: rep.replace,
        method: 'overlay',
        fontName: fontMatch?.font.baseFont ?? '—',
        fontWidthError: fontMatch ? fontMatch.error : null,
        fitScale: 1,
        pushed: 0,
        originalRemoved: false,
        notes: [],
      };
      reports.push(report);

      const located = fontMatch ? locateGlyphRun(streams, rep, fontMatch.font, fontFor) : null;
      if (located && located.total > 1) {
        report.notes.push('มี ' + located.total + ' จุดที่เขียนแบบเดียวกันในหน้านี้ — เลือกจุดตามตำแหน่งบนหน้า');
      }

      // 1. in-place glyph rewrite
      if (located && fontMatch) {
        const attempt = planNativeWithOverflow(rep, located, fontMatch.font);
        if ('plan' in attempt) {
          const { plan, shiftEdits, pushedBy, notes } = attempt;
          located.stream.text = applyEdits(located.stream.text, [...plan.edits, ...shiftEdits]);
          located.stream.dirty = true;
          report.pushed = pushedBy;
          report.method = 'native';
          report.fitScale = plan.fitScale;
          report.originalRemoved = true;
          if (plan.rewroteToken) {
            const tail = pushedBy > 0 ? 'แล้วปล่อยให้ข้อความหลังเลื่อนตาม' : 'แล้วชดเชยระยะให้ข้อความหลังอยู่ที่เดิม';
            report.notes.push(
              (plan.lengthChanged ? 'เขียนก้อนข้อความใหม่ (ยาวไม่เท่าเดิมได้) ' : 'เขียนก้อนข้อความใหม่') + tail,
            );
          } else if (plan.spacingAdjusted) {
            report.notes.push('ปรับระยะห่างตัวอักษรตามความกว้างจริงของตัวใหม่');
          }
          report.notes.push(...notes);
          if (plan.fitScale < 0.999) report.notes.push('บีบระยะเหลือ ' + Math.round(plan.fitScale * 100) + '% เพื่อไม่ให้ชนข้อความถัดไป');
          if (pushedBy > 0) {
            report.notes.push('ดันข้อความที่ตามมาในบรรทัดเดียวกันไปทางขวา ' + pushedBy.toFixed(2) + ' pt (ไม่บีบตัวอักษร)');
          }
          continue;
        }
        report.notes.push(attempt.error);
      } else if (!fontMatch) {
        report.notes.push('จับคู่ฟอนต์เดิมไม่ได้');
      } else {
        report.notes.push('หาตำแหน่งข้อความในไฟล์ไม่เจอ (เขียนด้วยวิธีที่ยังไม่รองรับ)');
      }

      // 2. delete the old glyphs so nothing is left hiding under the new text
      let erased = false;
      if (located) {
        const erasePlan = planEraseGlyphs(located.tokens, located.slots, located.match);
        if (!('error' in erasePlan)) {
          located.stream.text = applyEdits(located.stream.text, erasePlan.edits);
          located.stream.dirty = true;
          erased = true;
        } else {
          report.notes.push('ลบข้อความเดิมไม่ได้: ' + erasePlan.error);
        }
      }

      report.method = erased ? 'erase' : 'overlay';
      report.originalRemoved = erased;
      pending.push({ rep, font: fontMatch?.font ?? null, report, erased });
    }

    // in-place edits must land before pdf-lib wraps the streams for the draws
    writeStreams(page, streams);

    for (const item of pending) {
      const drawn = await drawText(pdfDoc, page, item.rep, item.font, fallbackCache, !item.erased);
      item.report.fitScale = drawn.fitScale;
      if (drawn.fontName) item.report.fontName = drawn.fontName;
      item.report.notes.push(...drawn.notes);
      item.report.notes.push(item.erased ? 'ลบข้อความเดิมออกจากไฟล์แล้ววาดตัวใหม่' : 'ทับพื้นหลังแล้ววาดตัวใหม่ (ข้อความเดิมยังอยู่ใน text layer)');
    }
  }

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  return { bytes, reports };
}
