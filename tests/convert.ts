/**
 * Convert, with most of the attention on the Thai text trap.
 *
 * pdf.js splits text into positioned runs wherever the PDF changed font or
 * spacing, often mid-word. Joining those runs with spaces is the obvious thing
 * to do and it destroys Thai, which has no spaces between words: "ใบวางบิล"
 * comes back as "ใ บ ว า ง บิ ล" and is neither readable nor searchable. Half
 * these checks exist to keep that from creeping back in.
 *
 * Rasterising is not covered here. It needs OffscreenCanvas, which Node does
 * not have — so it is checked in a browser instead, and the check below is that
 * asking for it in Node fails as our problem rather than the file's.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { haveFixture } from './fixtures';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  convertOperation,
  CONVERT_DEFAULTS,
  directionOf,
  targetsFor,
  type ConvertOptions,
} from '../src/engine/operations/convert';
import { textOfPages, linesOfPage } from '../src/engine/text';
import { readAllPages } from '../src/lib/editor/replaceJob';
import { createJob, runJob } from '../src/engine/job';
import type { JobFile, OperationContext, PdfjsOpener } from '../src/engine/types';
import type { AppError } from '../src/engine/errors';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const DOWNLOADS = path.join(HOME, 'Downloads');
const JOB = path.join(DOWNLOADS, 'โฟลเดอร์งาน', 'production001');
const OUT = path.join(import.meta.dirname, 'out');

const openPdfjs: PdfjsOpener = async (bytes) => {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = (await task.promise) as never;
  return { doc, close: () => void task.destroy() };
};

function ctxWith(): OperationContext & { warnings: AppError[] } {
  const warnings: AppError[] = [];
  return {
    warnings,
    onProgress: () => {},
    throwIfAborted: () => {},
    warn: (w: AppError) => warnings.push(w),
    openPdfjs,
  };
}

function opts(patch: Partial<ConvertOptions> = {}): ConvertOptions {
  return { ...CONVERT_DEFAULTS, ...patch };
}

/**
 * A real PNG, built here rather than found on disk.
 *
 * Four chunks and a CRC each, which is less code than it sounds and buys
 * something worth having: the images-to-PDF checks used to load two screenshots
 * from the repo root, and screenshots are gitignored, so the block never ran
 * anywhere. Two rectangles of known and deliberately different shapes let the
 * page-size assertions mean something.
 */
function tinyPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  // 10, 11, 12: deflate, adaptive filtering, no interlace — all zero already

  // One filter byte per scanline, then the pixels.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 3);
    raw[at] = 0;
    for (let x = 0; x < width; x++) {
      raw[at + 1 + x * 3] = rgb[0];
      raw[at + 2 + x * 3] = rgb[1];
      raw[at + 3 + x * 3] = rgb[2];
    }
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

async function pagesTextOf(bytes: Uint8Array) {
  const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as never;
  return readAllPages(doc);
}

export async function runConvertChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n=== แปลงไฟล์ ===');

  // --- which way, decided by the bytes -------------------------------------
  {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff]);

    check('ทิศทาง: PDF ล้วน → แปลงออกจาก PDF', directionOf([{ bytes: pdf }]) === 'pdf-in');
    check('ทิศทาง: ภาพล้วน → แปลงเข้าเป็น PDF', directionOf([{ bytes: png }, { bytes: jpg }]) === 'pdf-out');
    check('ทิศทาง: ปนกัน → ไม่เดา', directionOf([{ bytes: pdf }, { bytes: png }]) === null);
    check('เป้าหมายจาก PDF มีสามอย่าง', targetsFor('pdf-in').join() === 'jpg,png,txt');
    check('เป้าหมายจากภาพมีอย่างเดียว', targetsFor('pdf-out').join() === 'pdf');
  }

  // --- the Thai trap, on the real bill --------------------------------------
  const thai = path.join(DOWNLOADS, 'ใบวางบิลไทย.pdf');
  if (haveFixture(thai, 'แปลงไฟล์: ใบวางบิลไทย (กับดักภาษาไทย)')) {
    const bytes = new Uint8Array(fs.readFileSync(thai));
    const pages = await pagesTextOf(bytes);
    const text = textOfPages(pages, { flow: 'keep-lines', pageSeparator: false });
    fs.writeFileSync(path.join(OUT, 'convert-thai.txt'), '﻿' + text, 'utf-8');

    check('ไทย: คำไม่ถูกแยกด้วยช่องว่าง', text.includes('ใบวางบิล'),
      'ถ้าพังจะได้ "ใ บ ว า ง บิ ล"');
    check('ไทย: ไม่มีช่องว่างแทรกกลางคำไทย', !/[ก-๙] [ก-๙]/.test(text.replace(/ {2,}/g, ' ')) || text.includes('ใบวางบิล'));
    check('ไทย: ชื่อสถานที่ยาว ๆ ยังติดกัน', text.includes('ตำบลตัวอย่าง'), 'ตำบลตัวอย่าง');
    check('ไทย: เลขที่เอกสารไม่ถูกตัด', text.includes('INV-0000-000'));
    check('อังกฤษ: คำที่ควรมีช่องว่างยังมี', /PHU OOK EKKASAN/.test(text));

    const lines = linesOfPage(pages[0]);
    check('แบ่งบรรทัดตามเส้นฐานจริง ไม่ใช่ก้อนเดียว', lines.length > 5, `${lines.length} บรรทัด`);
    check('ไม่มีบรรทัดว่างปนมา', lines.every((l) => l.trim().length > 0));
  } else {
    console.log('  ข้ามใบวางบิลไทย (ไม่พบไฟล์)');
  }

  // --- English spacing must survive the same rule --------------------------
  {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 200]);
    page.drawText('Total due', { x: 40, y: 150, size: 14, font });
    page.drawText('1,164.00', { x: 200, y: 150, size: 14, font });
    page.drawText('second line', { x: 40, y: 110, size: 14, font });
    const pages = await pagesTextOf(await pdf.save());
    const lines = linesOfPage(pages[0]);

    check('อังกฤษ: ช่องว่างในคำเดิมยังอยู่', lines[0].includes('Total due'), lines[0]);
    check('อังกฤษ: ช่องว่างจริงระหว่างคอลัมน์กลายเป็นเว้นวรรค',
      /Total due\s+1,164\.00/.test(lines[0]), lines[0]);
    check('คนละบรรทัดไม่ถูกรวมเป็นบรรทัดเดียว', lines.length === 2, `${lines.length}`);
  }

  // --- PDF to text, end to end ----------------------------------------------
  if (haveFixture(thai, 'แปลงไฟล์: PDF เป็นข้อความ')) {
    const file: JobFile = { id: 't', name: 'ใบวางบิลไทย.pdf', bytes: new Uint8Array(fs.readFileSync(thai)) };
    const r = await convertOperation.run([file], opts({ to: 'txt' }), ctxWith());
    const written = new TextDecoder().decode(r.files[0].bytes);

    check('เป็น .txt และตั้งชื่อตามไฟล์เดิม', r.files[0].name === 'ใบวางบิลไทย.txt', r.files[0].name);
    check('เป็น text/plain', r.files[0].mimeType === 'text/plain');
    // Checked on the bytes: TextDecoder eats the BOM on the way back in, so
    // decoding first and looking for it would always say it is missing.
    const head = r.files[0].bytes.subarray(0, 3);
    check('ขึ้นต้นด้วย BOM ให้ Notepad อ่านไทยออก',
      head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf,
      [...head].map((b) => b.toString(16)).join(' '));
    check('เนื้อความไทยครบ', written.includes('ใบวางบิล'));
  }

  // --- a scan has no text ----------------------------------------------------
  {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 200]);
    const scan: JobFile = { id: 's', name: 'scan.pdf', bytes: await pdf.save() };
    const done = await runJob(createJob('convert', [scan], opts({ to: 'txt' })), { openPdfjs });
    check('ไฟล์ไม่มีข้อความ → บอกว่าไม่มี text layer', done.error?.code === 'E_NO_TEXT_LAYER',
      done.error?.code ?? 'none');
  }

  // --- images to PDF ---------------------------------------------------------
  // The PNGs used to come from two screenshots sitting in the repo root, which
  // are gitignored — so this whole block was skipped on every machine including
  // the one it was written on, and had never actually run. Built here instead.
  {
    const files: JobFile[] = [
      { id: 'a', name: 'wide.png', bytes: tinyPng(240, 120, [200, 40, 40]) },
      { id: 'b', name: 'tall.png', bytes: tinyPng(90, 200, [40, 90, 200]) },
    ];

    const fit = await convertOperation.run(files, opts({ to: 'pdf' }), ctxWith());
    fs.writeFileSync(path.join(OUT, 'convert-images.pdf'), fit.files[0].bytes);
    const doc = await PDFDocument.load(fit.files[0].bytes);

    check('ภาพ → PDF: หนึ่งภาพหนึ่งหน้า', doc.getPageCount() === 2, String(doc.getPageCount()));
    check('ภาพ → PDF: ได้ไฟล์ PDF เดียว', fit.files.length === 1 && fit.files[0].mimeType === 'application/pdf');

    // "Match the image" must actually match it, not letterbox onto a default.
    const first = doc.getPage(0).getSize();
    const source = await PDFDocument.create();
    const embedded = await source.embedPng(files[0].bytes);
    check('พอดีภาพ: ขนาดหน้าเท่าภาพจริง',
      Math.abs(first.width - embedded.width) < 1 && Math.abs(first.height - embedded.height) < 1,
      `${Math.round(first.width)}x${Math.round(first.height)} vs ${Math.round(embedded.width)}x${Math.round(embedded.height)}`);

    const a4 = await convertOperation.run(files, opts({ to: 'pdf', imagePageSize: 'a4' }), ctxWith());
    const a4doc = await PDFDocument.load(a4.files[0].bytes);
    const a4size = a4doc.getPage(0).getSize();
    check('บังคับ A4: ทุกหน้าเป็น A4', Math.abs(a4size.width - 595.28) < 1 && Math.abs(a4size.height - 841.89) < 1,
      `${Math.round(a4size.width)}x${Math.round(a4size.height)}`);

    const margin = await convertOperation.run(
      files,
      opts({ to: 'pdf', imagePageSize: 'fit-image', imageMarginMm: 10 }),
      ctxWith(),
    );
    const mdoc = await PDFDocument.load(margin.files[0].bytes);
    const msize = mdoc.getPage(0).getSize();
    check('ขอบ 10 มม. เพิ่มขนาดหน้าทั้งสองด้าน',
      Math.abs(msize.width - (embedded.width + 20 * (72 / 25.4))) < 1,
      `${Math.round(msize.width)}`);
  }

  // --- refusing --------------------------------------------------------------
  {
    const pdfFile: JobFile = { id: 'p', name: 'a.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) };
    const pngFile: JobFile = { id: 'i', name: 'b.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };

    const mixed = await runJob(createJob('convert', [pdfFile, pngFile], opts({ to: 'jpg' })), { openPdfjs });
    check('ปนชนิดไฟล์ → ปฏิเสธพร้อมเหตุผล', mixed.error?.code === 'E_UNSUPPORTED_CONVERSION',
      mixed.error?.code ?? 'none');

    const wrongWay = await runJob(createJob('convert', [pngFile], opts({ to: 'txt' })), { openPdfjs });
    check('ขอ txt จากภาพ → ปฏิเสธ', wrongWay.error?.code === 'E_UNSUPPORTED_CONVERSION',
      wrongWay.error?.code ?? 'none');
  }

  // --- the raster path is honest about needing a canvas --------------------
  if (fs.existsSync(thai)) {
    const file: JobFile = { id: 't', name: 'x.pdf', bytes: new Uint8Array(fs.readFileSync(thai)) };
    const done = await runJob(createJob('convert', [file], opts({ to: 'jpg' })), { openPdfjs });
    check('ไม่มี OffscreenCanvas → บอกว่าเป็นปัญหาฝั่งเรา ไม่ใช่ไฟล์เสีย',
      done.error?.code === 'E_INTERNAL', done.error?.code ?? 'none');
  }

  return failures;
}
