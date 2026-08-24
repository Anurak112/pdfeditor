/**
 * Compress — the one tool that is easy to fake.
 *
 * A re-save and a confident "12% smaller" would have passed review. Profiling
 * the real documents on this machine first is what stopped that: across seven
 * files people would plausibly want smaller, a plain pdf-lib re-save returned
 * 0.0%, 0.1%, 0.6%, 1.0% and 5.4% — and in every one of those files the images
 * were 94% to 100% of the bytes. There is no compression to be had anywhere
 * except in the image streams. The one file that gained from a re-save alone
 * (34%) had no images in it at all.
 *
 * So this reaches the images, and it is honest about the three things that
 * follow from that:
 *
 *   - a text-only document will barely move, and says so rather than
 *     manufacturing a number
 *   - re-encoding a photograph loses quality that cannot be recovered
 *   - some images cannot be touched at all, and are counted out loud
 */
import { PDFDict, PDFName } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { openSources } from '../document';
import { appWarning } from '../errors';
import { asPdfName, stem } from '../naming';
import { decodeSamples, listImages, replaceImage, scanPlacements } from '../images';
import type { ImageEntry, Placement } from '../images';
import { createZip } from '../../lib/utils/zip';
import { span } from '../types';
import type {
  ImageRecoder,
  JobFile,
  OperationContext,
  OperationResult,
  OutputFile,
  PdfOperation,
} from '../types';

export type CompressLevel = 'extreme' | 'recommended' | 'high-quality';

export interface CompressOptions {
  level: CompressLevel;
  /** Strip title, author, producer and friends. */
  stripMetadata: boolean;
  /**
   * Never hand back a file bigger than the one we were given — return the
   * original and say so instead. Off only for measuring in tests.
   */
  neverGrow: boolean;
}

export const COMPRESS_DEFAULTS: CompressOptions = {
  level: 'recommended',
  stripMetadata: true,
  neverGrow: true,
};

export interface CompressPreset {
  /** Resolution to keep, measured against how large the image is actually drawn. */
  dpi: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
}

/**
 * Three settings, not a slider.
 *
 * A slider invites the question "is 63 better than 61", which has no answer.
 * These are the three intents people actually have: small enough to email,
 * sensible, and barely-touched.
 *
 * Measured in a browser against real documents, at "recommended" unless noted:
 *
 *   36 MB slide deck, raw RGB images     36.2 MB -> 3.0 MB   -92%
 *      the same deck at "smallest"                -> 1.1 MB   -97%
 *      the same deck at "high quality"            -> 4.9 MB   -86%
 *   1.6 MB slide, one raw RGB image       1.60 MB -> 0.16 MB  -90%
 *   9.9 MB Thai scanned manual, JPEG      9.93 MB -> 2.75 MB  -72%
 *   368 KB invoice, 2000px logo            368 KB -> 103 KB   -72%
 *   670 KB report with no images at all    670 KB -> 444 KB   -34%
 *   any of the above, run a second time              no change, and says so
 *
 * In every case the page count, the page sizes and the text layer came back
 * byte-for-byte identical.
 */
export const COMPRESS_PRESETS: Record<CompressLevel, CompressPreset> = {
  extreme: { dpi: 96, quality: 0.5 },
  recommended: { dpi: 150, quality: 0.75 },
  'high-quality': { dpi: 220, quality: 0.88 },
};

/** Why an image was left alone. */
export type SkipReason =
  | 'too-small'
  | 'unsupported-filter'
  | 'unsupported-colour'
  | 'mask'
  | 'sample-tricks'
  | 'unreadable'
  | 'no-gain';

export interface CompressPlanItem {
  key: string;
  width: number;
  height: number;
  storedBytes: number;
  placement: Placement | null;
  /** Pixels per inch as the image is actually drawn, when we could work it out. */
  effectiveDpi: number | null;
  targetWidth: number;
  targetHeight: number;
  action: 'recode' | 'skip';
  reason?: SkipReason;
}

/**
 * Below this an image is furniture — an icon, a rule, a bullet.
 *
 * Re-encoding one saves a few hundred bytes and puts visible JPEG ringing
 * around something the eye is close to. The threshold is in pixels rather than
 * bytes because that is what decides whether the damage will show.
 */
const MIN_PIXELS = 40_000;
/** And below this there is not enough stored data for the round trip to pay. */
const MIN_STORED_BYTES = 4096;

/** Filters we can get pixels back out of. An empty name means the stream is already raw. */
const READABLE_FILTERS = new Set([
  '',
  '/FlateDecode',
  '/LZWDecode',
  '/RunLengthDecode',
  '/ASCII85Decode',
  '/ASCIIHexDecode',
]);

function classify(entry: ImageEntry): SkipReason | null {
  if (entry.isMask || entry.isMaskTarget) return 'mask';
  if (entry.hasSampleTricks) return 'sample-tricks';
  if (entry.width * entry.height < MIN_PIXELS) return 'too-small';
  if (entry.storedBytes < MIN_STORED_BYTES) return 'too-small';

  if (entry.filter === '/DCTDecode') {
    // A JPEG we can hand to the decoder whole. CMYK is the exception: browsers
    // disagree about Adobe's inverted four-channel JPEGs, and a compressor that
    // sometimes returns a photo negative is not one anybody can use.
    return entry.colour === 'rgb' || entry.colour === 'gray' ? null : 'unsupported-colour';
  }

  if (!READABLE_FILTERS.has(entry.filter)) return 'unsupported-filter';
  if (entry.bitsPerComponent !== 8) return 'unsupported-colour';
  if (entry.colour !== 'rgb' && entry.colour !== 'gray') return 'unsupported-colour';
  return null;
}

/**
 * What would be done, decided before anything is.
 *
 * Separate from the doing so the prediction line and the run cannot disagree,
 * and so the decisions can be checked against real documents in a test with no
 * browser in sight.
 */
export function compressPlan(
  entries: ImageEntry[],
  placements: Map<string, Placement>,
  options: CompressOptions,
): CompressPlanItem[] {
  const preset = COMPRESS_PRESETS[options.level];

  return entries.map((entry) => {
    const placement = placements.get(entry.key) ?? null;
    const effectiveDpi =
      placement && placement.widthPt > 1 ? Math.round(entry.width / (placement.widthPt / 72)) : null;

    let targetWidth = entry.width;
    let targetHeight = entry.height;

    if (placement && placement.widthPt > 1 && placement.heightPt > 1) {
      const roomW = (placement.widthPt / 72) * preset.dpi;
      const roomH = (placement.heightPt / 72) * preset.dpi;
      const scale = Math.min(1, roomW / entry.width, roomH / entry.height);
      if (scale < 1) {
        targetWidth = Math.max(1, Math.round(entry.width * scale));
        targetHeight = Math.max(1, Math.round(entry.height * scale));
      }
    }

    const reason = classify(entry);
    return {
      key: entry.key,
      width: entry.width,
      height: entry.height,
      storedBytes: entry.storedBytes,
      placement,
      effectiveDpi,
      targetWidth,
      targetHeight,
      action: reason ? 'skip' : 'recode',
      ...(reason ? { reason } : {}),
    };
  });
}

/**
 * Keep the new bytes only if they are meaningfully smaller.
 *
 * Anything closer than this is a quality loss bought for nothing.
 */
const WORTH_KEEPING = 0.95;

interface FileOutcome {
  name: string;
  bytes: Uint8Array;
  originalBytes: number;
  pages: number;
  recoded: number;
  skipped: Map<SkipReason, number>;
  /** True when we handed back the original because our attempt was no better. */
  keptOriginal: boolean;
}

function bump(counts: Map<SkipReason, number>, reason: SkipReason): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

/**
 * Removes the document's own description of itself.
 *
 * Rarely worth many bytes, and that is not the point — a document passed on to
 * someone else should not still carry the name of whoever's copy of Word made
 * it, or a title left over from the template it was cut from.
 */
function stripMetadata(doc: PDFDocument): void {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
      info.delete(PDFName.of(key));
    }
  }
  doc.catalog.delete(PDFName.of('Metadata'));
}

async function compressOne(
  entries: ImageEntry[],
  plan: CompressPlanItem[],
  doc: PDFDocument,
  file: JobFile,
  options: CompressOptions,
  recode: ImageRecoder | undefined,
  ctx: OperationContext,
  progress: { done: number; total: number; at: (done: number, total: number) => number },
): Promise<FileOutcome> {
  const skipped = new Map<SkipReason, number>();
  const byKey = new Map(entries.map((e) => [e.key, e]));
  let recodedCount = 0;

  for (const item of plan) {
    if (item.action === 'skip') {
      bump(skipped, item.reason ?? 'unsupported-filter');
      continue;
    }
    const entry = byKey.get(item.key);
    if (!entry || !recode) {
      bump(skipped, 'unreadable');
      continue;
    }

    ctx.throwIfAborted();
    progress.done++;
    ctx.onProgress(progress.at(progress.done, progress.total), {
      th: `กำลังบีบภาพในเอกสาร (${progress.done}/${progress.total})`,
      en: `Recompressing images (${progress.done}/${progress.total})`,
    });

    const source =
      entry.filter === '/DCTDecode'
        ? ({ kind: 'jpeg', bytes: entry.stream.contents } as const)
        : (() => {
            const samples = decodeSamples(doc.context, entry);
            if (!samples) return null;
            return { kind: 'samples', bytes: samples, components: entry.components as 1 | 3 } as const;
          })();

    if (!source) {
      bump(skipped, 'unreadable');
      continue;
    }

    const result = await recode({
      source,
      width: entry.width,
      height: entry.height,
      targetWidth: item.targetWidth,
      targetHeight: item.targetHeight,
      quality: COMPRESS_PRESETS[options.level].quality,
    });

    if (!result) {
      bump(skipped, 'unreadable');
      continue;
    }
    if (result.bytes.length >= entry.storedBytes * WORTH_KEEPING) {
      bump(skipped, 'no-gain');
      continue;
    }

    replaceImage(doc.context, entry, result);
    recodedCount++;
  }

  if (options.stripMetadata) stripMetadata(doc);

  const saved = await doc.save({ useObjectStreams: true });
  const grew = saved.length >= file.bytes.byteLength;

  return {
    name: file.name,
    bytes: options.neverGrow && grew ? file.bytes : saved,
    originalBytes: file.bytes.byteLength,
    pages: doc.getPageCount(),
    recoded: recodedCount,
    skipped,
    keptOriginal: options.neverGrow && grew,
  };
}

const SKIP_LABELS: Record<SkipReason, { th: string; en: string }> = {
  'too-small': { th: 'เล็กเกินกว่าจะได้อะไร', en: 'too small to gain from' },
  'unsupported-filter': { th: 'รูปแบบบีบอัดที่เบราว์เซอร์อ่านไม่ได้', en: 'a format the browser cannot read' },
  'unsupported-colour': { th: 'โหมดสีที่แปลงแล้วสีจะเพี้ยน', en: 'a colour mode we would shift' },
  mask: { th: 'เป็นชั้นความโปร่งใส', en: 'transparency layers' },
  'sample-tricks': { th: 'ใช้ค่าสีแบบพิเศษ', en: 'special colour handling' },
  unreadable: { th: 'อ่านข้อมูลภาพไม่ออก', en: 'unreadable image data' },
  'no-gain': { th: 'บีบแล้วไม่เล็กลง', en: 'already as small as it gets' },
};

async function run(files: JobFile[], options: CompressOptions, ctx: OperationContext): Promise<OperationResult> {
  const sources = await openSources(files, { progress: { from: 0, to: 10 } }, ctx);

  ctx.onProgress(12, { th: 'กำลังดูว่ามีอะไรให้ลดบ้าง', en: 'Looking for what can be reduced' });

  // Planned for every file before any is written, so the progress bar counts
  // real work rather than files, and so a document with nothing to gain is
  // known before it is touched.
  const prepared = sources.map(({ source }) => {
    const entries = listImages(source.doc);
    const placements = scanPlacements(source.doc);
    return { source, entries, plan: compressPlan(entries, placements, options) };
  });

  const total = prepared.reduce((n, p) => n + p.plan.filter((i) => i.action === 'recode').length, 0);
  const progress = { done: 0, total: Math.max(1, total), at: span(14, 88) };

  const outcomes: FileOutcome[] = [];
  for (const { source, entries, plan } of prepared) {
    ctx.throwIfAborted();
    outcomes.push(
      await compressOne(entries, plan, source.doc, source.file, options, ctx.recodeImage, ctx, progress),
    );
  }

  const originalBytes = outcomes.reduce((n, o) => n + o.originalBytes, 0);
  const compressedBytes = outcomes.reduce((n, o) => n + o.bytes.byteLength, 0);
  const savedPercent = originalBytes > 0 ? ((originalBytes - compressedBytes) / originalBytes) * 100 : 0;

  // Under one percent is not a result, it is rounding. Saying so is the whole
  // difference between this and a tool that always claims a win.
  if (savedPercent < 1) {
    ctx.warn(
      appWarning('W_ALREADY_OPTIMIZED', {
        hint: outcomes.some((o) => o.recoded > 0)
          ? {
              th: 'ลองบีบภาพในไฟล์แล้ว แต่ของเดิมบีบมาดีอยู่แล้ว',
              en: 'The images were re-encoded, but the originals were already well packed',
            }
          : {
              th: 'ไฟล์นี้แทบไม่มีภาพ — ข้อความกับเส้นบีบต่อไม่ได้แล้ว',
              en: 'There are almost no images here, and text and vectors are already as small as they go',
            },
      }),
    );
  }

  const allSkips = new Map<SkipReason, number>();
  for (const outcome of outcomes) {
    for (const [reason, n] of outcome.skipped) allSkips.set(reason, (allSkips.get(reason) ?? 0) + n);
  }
  // 'too-small' and 'no-gain' are the tool working correctly, not a limitation.
  const notable = [...allSkips].filter(([reason]) => reason !== 'too-small' && reason !== 'no-gain');
  if (notable.length > 0) {
    const count = notable.reduce((n, [, v]) => n + v, 0);
    ctx.warn(
      appWarning('W_IMAGES_SKIPPED', {
        hint: {
          th: `${count} ภาพถูกข้าม: ${notable.map(([r, n]) => `${n} ${SKIP_LABELS[r].th}`).join(' · ')}`,
          en: `${count} images left alone: ${notable.map(([r, n]) => `${n} ${SKIP_LABELS[r].en}`).join('; ')}`,
        },
      }),
    );
  }

  ctx.onProgress(92, { th: 'กำลังเขียนไฟล์', en: 'Writing the files' });

  const outputs: OutputFile[] = outcomes.map((o) => ({
    name: asPdfName(`${stem(o.name)}-เล็กลง`),
    bytes: o.bytes,
    mimeType: 'application/pdf',
  }));

  const stats = {
    originalBytes,
    outputBytes: compressedBytes,
    savedPercent: Math.max(0, savedPercent),
    pagesProcessed: outcomes.reduce((n, o) => n + o.pages, 0),
  };

  if (outputs.length === 1) return { files: outputs, stats };

  const zip = createZip(outputs.map((o) => ({ name: o.name, bytes: o.bytes })));
  return {
    files: [{ name: 'เล็กลง.zip', bytes: zip, mimeType: 'application/zip' }],
    stats: { ...stats, outputBytes: zip.byteLength },
  };
}

export const compressOperation: PdfOperation<CompressOptions> = { id: 'compress', run };
