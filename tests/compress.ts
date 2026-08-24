/**
 * Compress, checked against documents that exist rather than ones invented to
 * pass.
 *
 * The encoder is injected, so Node can run the whole pipeline: these checks
 * downsample with a box filter and re-deflate, which produces real, valid image
 * streams that pdf.js is then asked to open. What Node cannot do is decode a
 * JPEG — there is no decoder here — so this recoder declines those, and that
 * declining is itself one of the paths worth exercising.
 *
 * That gap is worth naming, because it moves the numbers a long way: the 1.6 MB
 * slide below comes out -0.7% here and -90% in a browser, because flate-to-flate
 * has almost nothing to give and flate-to-JPEG has almost everything. The
 * measurements that count are in the comment above COMPRESS_PRESETS, taken from
 * a browser; the ones printed here are a floor, and a regression alarm.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import type { PDFDict } from 'pdf-lib';
import {
  COMPRESS_DEFAULTS,
  COMPRESS_PRESETS,
  compressOperation,
  compressPlan,
  type CompressOptions,
} from '../src/engine/operations/compress';
import { decodeSamples, listImages, scanPlacements } from '../src/engine/images';
import { createJob, runJob } from '../src/engine/job';
import type { ImageRecoder, JobFile, OperationContext } from '../src/engine/types';
import type { AppError } from '../src/engine/errors';

const DOWNLOADS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? os.homedir(), 'Downloads');
const OUT = path.join(import.meta.dirname, 'out');

// ---------------------------------------------------------------------------
// a real encoder, in Node
// ---------------------------------------------------------------------------

/** Box filter. Averaging beats dropping pixels, and it is eight lines either way. */
function resample(
  src: Uint8Array,
  sw: number,
  sh: number,
  components: number,
  dw: number,
  dh: number,
): Uint8Array {
  if (dw === sw && dh === sh) return src;
  const out = new Uint8Array(dw * dh * components);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      for (let c = 0; c < components; c++) {
        let sum = 0;
        let n = 0;
        for (let sy = y0; sy < y1 && sy < sh; sy++) {
          for (let sx = x0; sx < x1 && sx < sw; sx++) {
            sum += src[(sy * sw + sx) * components + c];
            n++;
          }
        }
        out[(y * dw + x) * components + c] = n > 0 ? Math.round(sum / n) : 0;
      }
    }
  }
  return out;
}

const nodeRecoder: ImageRecoder = async (image) => {
  if (image.source.kind === 'jpeg') return null; // no JPEG decoder here
  const { bytes, components } = image.source;
  const resized = resample(bytes, image.width, image.height, components, image.targetWidth, image.targetHeight);
  return {
    format: 'flate',
    bytes: new Uint8Array(zlib.deflateSync(resized, { level: 9 })),
    width: image.targetWidth,
    height: image.targetHeight,
    components,
  };
};

/** Refuses everything, for the paths that are about what happens when it cannot. */
const decliningRecoder: ImageRecoder = async () => null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ctxWith(recodeImage: ImageRecoder | undefined = nodeRecoder): OperationContext & { warnings: AppError[] } {
  const warnings: AppError[] = [];
  return {
    warnings,
    onProgress: () => {},
    throwIfAborted: () => {},
    warn: (w: AppError) => warnings.push(w),
    recodeImage,
  };
}

function opts(patch: Partial<CompressOptions> = {}): CompressOptions {
  return { ...COMPRESS_DEFAULTS, ...patch };
}

function kb(n: number): string {
  return (n / 1024).toFixed(0) + ' KB';
}

async function openPdfjs(bytes: Uint8Array) {
  return (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as unknown as {
    numPages: number;
    getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number } }>;
  };
}

/** A page-sized RGB image, deflated, with the PNG predictor a real producer would leave behind. */
function pngPredicted(width: number, height: number): { raw: Uint8Array; encoded: Uint8Array } {
  const raw = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      raw[at] = (x * 7 + y * 3) & 0xff;
      raw[at + 1] = (x * 3 + y * 11) & 0xff;
      raw[at + 2] = (x ^ y) & 0xff;
    }
  }

  // Every filter type in turn, so the undo is exercised on all five rather than
  // on whichever one a single producer happens to favour.
  const rowLength = width * 3;
  const filtered = new Uint8Array(height * (rowLength + 1));
  for (let y = 0; y < height; y++) {
    const type = y % 5;
    const at = y * (rowLength + 1);
    filtered[at] = type;
    for (let i = 0; i < rowLength; i++) {
      const value = raw[y * rowLength + i];
      const left = i >= 3 ? raw[y * rowLength + i - 3] : 0;
      const up = y > 0 ? raw[(y - 1) * rowLength + i] : 0;
      const upLeft = y > 0 && i >= 3 ? raw[(y - 1) * rowLength + i - 3] : 0;
      let predictor = 0;
      if (type === 1) predictor = left;
      else if (type === 2) predictor = up;
      else if (type === 3) predictor = (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      filtered[at + 1 + i] = (value - predictor) & 0xff;
    }
  }

  return { raw, encoded: new Uint8Array(zlib.deflateSync(filtered, { level: 9 })) };
}

/**
 * A minimal PDF, written by hand with a real cross-reference table.
 *
 * pdf-lib cannot round-trip this without adding bytes — it writes an object
 * stream and a cross-reference stream where this has three short objects and a
 * table. That makes it the fixture the never-grow rule needs: a file where
 * doing the work honestly produces a worse result than doing nothing.
 */
function tinyPdf(): Uint8Array {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>',
  ];

  const EOL = '\n';
  let body = '%PDF-1.4' + EOL;
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj${object}endobj` + EOL;
  });

  const startxref = body.length;
  body += `xref${EOL}0 ${objects.length + 1}${EOL}0000000000 65535 f ${EOL}`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n ${EOL}`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>${EOL}`;
  body += `startxref${EOL}${startxref}${EOL}%%EOF${EOL}`;

  return new TextEncoder().encode(body);
}

/** Builds a document holding one image object, described however the test needs. */
async function docWithImage(
  bytes: Uint8Array,
  dictEntries: Record<string, unknown>,
  draw?: { widthPt: number; heightPt: number },
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const dict = doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...dictEntries }) as PDFDict;
  const ref = doc.context.register(PDFRawStream.of(dict, bytes));

  if (draw) {
    const resources = page.node.Resources();
    const xobjects = doc.context.obj({}) as PDFDict;
    xobjects.set(PDFName.of('Im0'), ref);
    resources?.set(PDFName.of('XObject'), xobjects);
    const content = `q ${draw.widthPt} 0 0 ${draw.heightPt} 40 40 cm /Im0 Do Q`;
    const stream = doc.context.flateStream(content);
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  }
  return doc;
}

// ---------------------------------------------------------------------------

export async function runCompressChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n=== ลดขนาด ===');

  // --- reading pixels back out ---------------------------------------------
  {
    const { raw, encoded } = pngPredicted(64, 48);
    const doc = await docWithImage(encoded, {
      Width: 64,
      Height: 48,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: 3, Columns: 64, BitsPerComponent: 8 },
    });
    const entries = listImages(doc);
    check('เจอภาพในไฟล์', entries.length === 1, String(entries.length));
    const samples = entries[0] ? decodeSamples(doc.context, entries[0]) : null;
    check('ถอด PNG predictor ได้ครบทุกไบต์',
      samples !== null && samples.length === raw.length && samples.every((v, i) => v === raw[i]),
      samples ? `ได้ ${samples.length} ไบต์` : 'ถอดไม่ออก');
  }

  {
    // The same data with the predictor claimed but not applied must not come
    // back looking plausible — a silently wrong decode is worse than a refusal.
    const plain = new Uint8Array(zlib.deflateSync(new Uint8Array(64 * 48 * 3).fill(200)));
    const doc = await docWithImage(plain, {
      Width: 64, Height: 48, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
    });
    const samples = decodeSamples(doc.context, listImages(doc)[0]);
    check('ภาพ Flate ธรรมดาถอดได้', samples?.length === 64 * 48 * 3, String(samples?.length));
  }

  // --- deciding what to touch ----------------------------------------------
  {
    const big = new Uint8Array(zlib.deflateSync(new Uint8Array(2000 * 2000 * 3).fill(120)));
    // 2000px drawn across two inches: 1000 dpi of detail nobody can see.
    const doc = await docWithImage(
      big,
      { Width: 2000, Height: 2000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' },
      { widthPt: 144, heightPt: 144 },
    );
    const entries = listImages(doc);
    const placements = scanPlacements(doc);
    check('รู้ว่าภาพถูกวาดใหญ่แค่ไหนจริง ๆ',
      Math.round(placements.get(entries[0].key)?.widthPt ?? 0) === 144,
      String(placements.get(entries[0].key)?.widthPt));

    const plan = compressPlan(entries, placements, opts());
    check('คำนวณ dpi จริงของภาพได้', plan[0].effectiveDpi === 1000, String(plan[0].effectiveDpi));
    check('ย่อลงตาม dpi ที่ตั้งไว้ ไม่ใช่ตามขนาดหน้า',
      plan[0].targetWidth === Math.round((144 / 72) * COMPRESS_PRESETS.recommended.dpi),
      `${plan[0].targetWidth}px`);

    const gentle = compressPlan(entries, placements, opts({ level: 'high-quality' }));
    const harsh = compressPlan(entries, placements, opts({ level: 'extreme' }));
    check('ระดับที่เข้มกว่าย่อมากกว่าเสมอ',
      harsh[0].targetWidth < plan[0].targetWidth && plan[0].targetWidth < gentle[0].targetWidth,
      `${harsh[0].targetWidth} < ${plan[0].targetWidth} < ${gentle[0].targetWidth}`);
  }

  {
    // Already coarser than the setting asks for: leave the pixels alone. The
    // picture has to be real detail rather than a flat fill, or it deflates to
    // nothing and gets skipped as furniture — which is correct behaviour and
    // would have made this check pass for the wrong reason.
    const { encoded } = pngPredicted(300, 300);
    const doc = await docWithImage(
      encoded,
      {
        Width: 300, Height: 300, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, Columns: 300, BitsPerComponent: 8 },
      },
      { widthPt: 400, heightPt: 400 },
    );
    const entries = listImages(doc);
    const plan = compressPlan(entries, scanPlacements(doc), opts());
    check('ภาพที่หยาบอยู่แล้วไม่ถูกย่อซ้ำ',
      plan[0].targetWidth === 300 && plan[0].action === 'recode',
      `${plan[0].targetWidth}px ${plan[0].action} (${plan[0].effectiveDpi} dpi)`);
  }

  // --- what it refuses to touch, and why ------------------------------------
  {
    const cases: { label: string; dict: Record<string, unknown>; reason: string }[] = [
      {
        label: 'ภาพเล็กมาก',
        dict: { Width: 60, Height: 60, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' },
        reason: 'too-small',
      },
      {
        label: 'ฟอร์แมตที่เบราว์เซอร์อ่านไม่ได้ (JPEG 2000)',
        dict: { Width: 900, Height: 900, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' },
        reason: 'unsupported-filter',
      },
      {
        label: 'CMYK — แปลงแล้วสีเพี้ยน',
        dict: { Width: 900, Height: 900, BitsPerComponent: 8, ColorSpace: 'DeviceCMYK', Filter: 'DCTDecode' },
        reason: 'unsupported-colour',
      },
      {
        label: 'ภาพขาวดำ 1 บิต',
        dict: { Width: 900, Height: 900, BitsPerComponent: 1, ImageMask: true, Filter: 'FlateDecode' },
        reason: 'mask',
      },
      {
        label: 'มี /Decode array กลับค่าสี',
        dict: {
          Width: 900, Height: 900, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
          Decode: [1, 0, 1, 0, 1, 0],
        },
        reason: 'sample-tricks',
      },
    ];

    for (const { label, dict, reason } of cases) {
      const doc = await docWithImage(new Uint8Array(9000).fill(1), dict);
      const plan = compressPlan(listImages(doc), new Map(), opts());
      check(`ข้าม: ${label}`, plan[0]?.action === 'skip' && plan[0]?.reason === reason,
        `${plan[0]?.action} ${plan[0]?.reason ?? ''}`);
    }
  }

  {
    // A soft mask is an image by every structural test and must not be treated
    // as one: a lossy alpha channel puts a halo around whatever it cuts out.
    const doc = await PDFDocument.create();
    doc.addPage();
    const maskDict = doc.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 900, Height: 900,
      BitsPerComponent: 8, ColorSpace: 'DeviceGray', Filter: 'FlateDecode',
    }) as PDFDict;
    const maskRef = doc.context.register(PDFRawStream.of(maskDict, new Uint8Array(9000).fill(1)));
    const baseDict = doc.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 900, Height: 900,
      BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
    }) as PDFDict;
    baseDict.set(PDFName.of('SMask'), maskRef);
    doc.context.register(PDFRawStream.of(baseDict, new Uint8Array(9000).fill(2)));

    const plan = compressPlan(listImages(doc), new Map(), opts());
    const mask = plan.find((p) => p.reason === 'mask');
    check('ชั้นความโปร่งใสไม่ถูกบีบทับ', plan.length === 2 && mask !== undefined,
      plan.map((p) => p.action + (p.reason ? ':' + p.reason : '')).join(' '));
  }

  // --- end to end, with real bytes -----------------------------------------
  {
    const { encoded } = pngPredicted(1200, 900);
    const doc = await docWithImage(
      encoded,
      {
        Width: 1200, Height: 900, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, Columns: 1200, BitsPerComponent: 8 },
      },
      { widthPt: 288, heightPt: 216 },
    );
    const original = await doc.save({ useObjectStreams: true });
    const file: JobFile = { id: 'a', name: 'ใบเสร็จ.pdf', bytes: original };

    const ctx = ctxWith();
    const result = await compressOperation.run([file], opts(), ctx);
    const out = result.files[0];
    fs.writeFileSync(path.join(OUT, 'compress-flate.pdf'), out.bytes);

    check('ไฟล์เล็กลงจริง', out.bytes.byteLength < original.byteLength,
      `${kb(original.byteLength)} -> ${kb(out.bytes.byteLength)}`);
    check('สถิติที่รายงานตรงกับไฟล์ที่ได้',
      result.stats?.outputBytes === out.bytes.byteLength &&
        Math.round(result.stats?.savedPercent ?? 0) ===
          Math.round(((original.byteLength - out.bytes.byteLength) / original.byteLength) * 100),
      `-${Math.round(result.stats?.savedPercent ?? 0)}%`);
    check('ตั้งชื่อไฟล์ภาษาไทยได้', out.name === 'ใบเสร็จ-เล็กลง.pdf', out.name);

    // The point of all of it: the result is still a document.
    const reopened = await openPdfjs(out.bytes);
    check('ไฟล์ที่ได้ยังเปิดได้ หน้าครบ', reopened.numPages === 1, String(reopened.numPages));

    const back = await PDFDocument.load(out.bytes);
    const entry = listImages(back)[0];
    check('ภาพถูกย่อจริงตามแผน',
      entry.width === Math.round((288 / 72) * COMPRESS_PRESETS.recommended.dpi),
      `${entry.width}x${entry.height}`);
    check('พจนานุกรมของภาพถูกเขียนใหม่ให้ตรงกับข้อมูลใหม่',
      entry.filter === '/FlateDecode' &&
        entry.bitsPerComponent === 8 &&
        entry.stream.dict.get(PDFName.of('DecodeParms')) === undefined,
      `filter=${entry.filter} parms=${entry.stream.dict.get(PDFName.of('DecodeParms')) ? 'ยังอยู่' : 'ลบแล้ว'}`);
    check('ข้อมูลภาพใหม่ถอดกลับได้ ขนาดตรงกับที่ประกาศ',
      decodeSamples(back.context, entry)?.length === entry.width * entry.height * 3);
  }

  // --- never hand back something bigger ------------------------------------
  {
    // A document already written more tightly than pdf-lib writes one. Rewriting
    // it makes it bigger, which is the case the rule exists for — and testing it
    // against a file that would not have grown anyway proves nothing.
    const original = tinyPdf();
    const file: JobFile = { id: 'b', name: 'tiny.pdf', bytes: original };

    const grown = await compressOperation.run(
      [file],
      opts({ neverGrow: false, stripMetadata: false }),
      ctxWith(decliningRecoder),
    );
    check('ตั้งใจปิดกฎแล้ว ไฟล์โตขึ้นจริง (ยืนยันว่าเคสนี้โตได้)',
      grown.files[0].bytes.byteLength > original.byteLength,
      `${original.byteLength} -> ${grown.files[0].bytes.byteLength} ไบต์`);

    const ctx = ctxWith(decliningRecoder);
    const result = await compressOperation.run([file], opts({ stripMetadata: false }), ctx);
    check('เปิดกฎแล้ว คืนต้นฉบับเป๊ะ ๆ ทุกไบต์',
      result.files[0].bytes.byteLength === original.byteLength &&
        result.files[0].bytes.every((b, i) => b === original[i]),
      `${original.byteLength} -> ${result.files[0].bytes.byteLength} ไบต์`);
    check('และบอกตรง ๆ ว่าไม่มีอะไรให้ลด',
      ctx.warnings.some((w) => w.code === 'W_ALREADY_OPTIMIZED'),
      ctx.warnings.map((w) => w.code).join(' '));
    check('ไม่โม้เปอร์เซ็นต์ที่ไม่ได้เกิดขึ้น',
      (result.stats?.savedPercent ?? 0) === 0, `${result.stats?.savedPercent?.toFixed(2)}%`);
  }

  // --- metadata -------------------------------------------------------------
  {
    const doc = await PDFDocument.create();
    doc.addPage().drawText('x');
    doc.setTitle('แบบร่างที่ยังไม่ควรส่งใคร');
    doc.setAuthor('someone else');
    const original = await doc.save();

    const kept = await compressOperation.run(
      [{ id: 'c', name: 'meta.pdf', bytes: original }],
      opts({ stripMetadata: false, neverGrow: false }),
      ctxWith(decliningRecoder),
    );
    const stripped = await compressOperation.run(
      [{ id: 'c', name: 'meta.pdf', bytes: original }],
      opts({ stripMetadata: true, neverGrow: false }),
      ctxWith(decliningRecoder),
    );

    const reopen = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
    const keptDoc = await reopen(kept.files[0].bytes);
    const strippedDoc = await reopen(stripped.files[0].bytes);

    check('ปิดสวิตช์แล้วข้อมูลผู้เขียนยังอยู่', keptDoc.getTitle() !== undefined);
    check('เปิดสวิตช์แล้วชื่อเรื่องกับผู้เขียนหายไป',
      strippedDoc.getTitle() === undefined, String(strippedDoc.getTitle()));

    // Compress re-saves the document it was handed rather than building a new
    // one, so nothing about it should re-author the file. pdf-lib's loader will
    // happily stamp its own name as Producer if not told otherwise, which is a
    // change nobody asked for on a tool that only makes images smaller.
    const authored = await PDFDocument.create();
    authored.addPage([200, 200]);
    authored.setProducer('เครื่องพิมพ์ของกรมพัฒนาธุรกิจการค้า');
    authored.setCreator('ระบบออกเอกสาร');
    const before = await authored.save();
    const after = await reopen(
      (
        await compressOperation.run(
          [{ id: 'meta2', name: 'meta2.pdf', bytes: before }],
          opts({ stripMetadata: false, neverGrow: false }),
          ctxWith(decliningRecoder),
        )
      ).files[0].bytes,
    );
    check('บีบไฟล์แล้วชื่อโปรแกรมที่สร้างเอกสารเดิมไม่ถูกเขียนทับ',
      after.getProducer() === 'เครื่องพิมพ์ของกรมพัฒนาธุรกิจการค้า' && after.getCreator() === 'ระบบออกเอกสาร',
      `${after.getProducer()} / ${after.getCreator()}`);
  }

  // --- several files at once ------------------------------------------------
  {
    const { encoded } = pngPredicted(800, 600);
    const make = async (name: string): Promise<JobFile> => {
      const doc = await docWithImage(
        encoded,
        {
          Width: 800, Height: 600, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: 3, Columns: 800, BitsPerComponent: 8 },
        },
        { widthPt: 200, heightPt: 150 },
      );
      return { id: name, name, bytes: await doc.save() };
    };
    const files = [await make('หนึ่ง.pdf'), await make('สอง.pdf')];
    const result = await compressOperation.run(files, opts(), ctxWith());
    check('หลายไฟล์ห่อเป็น ZIP ชิ้นเดียว',
      result.files.length === 1 && result.files[0].mimeType === 'application/zip',
      result.files[0].mimeType);
    check('สถิติรวมนับต้นฉบับครบทุกไฟล์',
      result.stats?.originalBytes === files.reduce((n, f) => n + f.bytes.byteLength, 0));
  }

  // --- through the job layer, and refusing what it cannot open --------------
  {
    const { encoded } = pngPredicted(900, 700);
    const doc = await docWithImage(
      encoded,
      {
        Width: 900, Height: 700, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, Columns: 900, BitsPerComponent: 8 },
      },
      { widthPt: 216, heightPt: 168 },
    );
    const bytes = await doc.save();
    const done = await runJob(createJob('compress', [{ id: 'd', name: 'j.pdf', bytes }], opts()), {
      recodeImage: nodeRecoder,
    });
    check('ผ่าน runJob สำเร็จ', done.state === 'done', done.state);
    check('runJob รายงานว่าเล็กลง', (done.result?.stats?.savedPercent ?? 0) > 1,
      `-${done.result?.stats?.savedPercent?.toFixed(1)}%`);

    const noEncoder = await runJob(createJob('compress', [{ id: 'd', name: 'j.pdf', bytes }], opts()));
    check('โฮสต์ที่ไม่มีตัวเข้ารหัส ไม่พัง — คืนต้นฉบับพร้อมคำเตือน',
      noEncoder.state === 'done' && noEncoder.warnings.some((w) => w.code === 'W_ALREADY_OPTIMIZED'),
      `${noEncoder.state} ${noEncoder.warnings.map((w) => w.code).join(' ')}`);
  }

  // --- real documents, measured --------------------------------------------
  await measureRealDocuments(check);

  return failures;
}

/**
 * The numbers, from documents that were on this machine before the tool existed.
 *
 * Not assertions — a fixture that only exists on one laptop cannot be a gate,
 * and the ratios move with the document. They are printed so that a change that
 * quietly stops compressing shows up as a number nobody can misread.
 */
async function measureRealDocuments(check: (l: string, ok: boolean, d?: string) => void): Promise<void> {
  const candidates = [
    { file: 'Untitled.pdf', note: '15 สไลด์ ภาพดิบ Flate ล้วน' },
    { file: 'มัดจำ.pdf', note: 'สไลด์เดียว ภาพ Flate' },
    { file: 'ใบแจ้งหนี้มีโลโก้.pdf', note: 'ใบแจ้งหนี้ + โลโก้ 2000x2000' },
    { file: 'เอกสารข้อความล้วน.pdf', note: 'ข้อความล้วน ไม่มีภาพเลย' },
  ];

  let ran = 0;
  for (const { file, note } of candidates) {
    const full = path.join(DOWNLOADS, file);
    if (!fs.existsSync(full)) continue;
    const bytes = new Uint8Array(fs.readFileSync(full));
    // The 37 MB deck is the best fixture here and much the slowest; the box
    // filter in this file is not what ships, so measuring it is not worth a
    // minute of every test run.
    if (bytes.byteLength > 4 * 1024 * 1024) {
      console.log(`  (ข้าม ${file} — ${kb(bytes.byteLength)} ใหญ่เกินกว่าจะวัดทุกรอบ)`);
      continue;
    }

    const ctx = ctxWith();
    const started = Date.now();
    const result = await compressOperation.run([{ id: file, name: file, bytes }], opts(), ctx);
    const after = result.files[0].bytes.byteLength;
    ran++;
    console.log(
      `  วัดจริง: ${file}  ${kb(bytes.byteLength)} -> ${kb(after)}  ` +
        `(-${(result.stats?.savedPercent ?? 0).toFixed(1)}%, ${Date.now() - started}ms)  ${note}`,
    );

    check(`${file}: ไม่ใหญ่กว่าเดิม`, after <= bytes.byteLength, `${kb(bytes.byteLength)} -> ${kb(after)}`);
    const reopened = await openPdfjs(result.files[0].bytes);
    const originalPages = await openPdfjs(bytes);
    check(`${file}: หน้าครบเท่าเดิมและยังเปิดได้`, reopened.numPages === originalPages.numPages,
      `${originalPages.numPages} -> ${reopened.numPages}`);
  }

  if (ran === 0) console.log('  (ไม่มีเอกสารจริงให้วัดบนเครื่องนี้ — ข้ามส่วนวัดผล)');
}
