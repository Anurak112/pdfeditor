/**
 * Split, checked by reading back which pages landed in which file.
 *
 * Counting files proves very little: asking for three ranges and getting three
 * files says nothing about whether the boundaries fell where they were asked
 * for. Every check below names the pages it expects, per output.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { splitOperation, SPLIT_DEFAULTS, splitPlan, type SplitOptions } from '../src/engine/operations/split';
import { createJob, runJob } from '../src/engine/job';
import type { JobFile, OperationContext, OutputFile } from '../src/engine/types';
import type { AppError } from '../src/engine/errors';

const OUT = path.join(import.meta.dirname, 'out');

function ctxWith(): OperationContext & { warnings: AppError[] } {
  const warnings: AppError[] = [];
  return {
    warnings,
    onProgress: () => {},
    throwIfAborted: () => {},
    warn: (w: AppError) => warnings.push(w),
  };
}

function opts(patch: Partial<SplitOptions> = {}): SplitOptions {
  return { ...SPLIT_DEFAULTS, ...patch };
}

/** Ten pages that each say which one they are. */
async function numbered(pages = 10): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    pdf.addPage([300, 400]).drawText(`PAGE ${i}`, { x: 30, y: 340, size: 26, font });
  }
  return pdf.save();
}

async function pagesOf(bytes: Uint8Array): Promise<string[]> {
  const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as unknown as {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  };
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const c = await (await doc.getPage(n)).getTextContent();
    out.push(c.items.map((i) => (i as { str?: string }).str ?? '').join('').trim());
  }
  return out;
}

/** The day the imaginary certificate below was issued. */
const ISSUED_ON = new Date(Date.UTC(2019, 4, 17, 9, 30, 0));

/** Ten pages that say who issued them, and when. */
async function issued(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 10; i++) {
    pdf.addPage([300, 400]).drawText(`PAGE ${i}`, { x: 30, y: 340, size: 26, font });
  }
  pdf.setTitle('หนังสือรับรองการจดทะเบียน');
  pdf.setAuthor('กรมพัฒนาธุรกิจการค้า');
  pdf.setCreator('ระบบออกเอกสาร e-Certificate');
  pdf.setProducer('เครื่องพิมพ์ของกรมพัฒนาธุรกิจการค้า');
  pdf.setCreationDate(ISSUED_ON);
  return pdf.save();
}

/** PDF dates are written to the second, so compare them at that resolution. */
function sameSecond(a: Date | undefined, b: Date): boolean {
  return a !== undefined && Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
}

/** Each output as "PAGE 1+PAGE 2", so a whole plan fits on one line. */
async function shape(outputs: OutputFile[]): Promise<string> {
  const parts: string[] = [];
  for (const o of outputs) parts.push((await pagesOf(o.bytes)).join('+'));
  return parts.join(' | ');
}

/** Reads the stored entries back out of our own ZIP, by its central directory. */
function zipNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  for (let i = 0; i < bytes.length - 4; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLen)));
  }
  return names;
}

export async function runSplitChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n=== แยกหน้า ===');
  const source = await numbered(10);
  const file = (): JobFile => ({ id: 's', name: 'numbered.pdf', bytes: source });

  // --- the plan, shared with the prediction line ---------------------------
  {
    check('แผน: ดึงรวม = 1 กลุ่ม',
      JSON.stringify(splitPlan(10, opts({ pages: [0, 2, 4] })).groups) === '[[0,2,4]]');
    check('แผน: ดึงแยก = กลุ่มละหน้า',
      JSON.stringify(splitPlan(10, opts({ mode: 'extract-separate', pages: [0, 2] })).groups) === '[[0],[2]]');
    check('แผน: ทุก 3 หน้า จาก 10 = 4 กลุ่ม',
      splitPlan(10, opts({ mode: 'every-n', everyN: 3 })).groups.length === 4);
    check('แผน: หน้าที่เลือกซ้ำถูกยุบ',
      JSON.stringify(splitPlan(10, opts({ pages: [2, 2, 0] })).groups) === '[[0,2]]');
    check('แผน: หน้าที่ค้างจากไฟล์ก่อนถูกตัดทิ้ง',
      JSON.stringify(splitPlan(3, opts({ pages: [0, 9] })).groups) === '[[0]]');
  }

  // --- extract, merged ------------------------------------------------------
  {
    const r = await splitOperation.run([file()], opts({ pages: [0, 4, 9] }), ctxWith());
    check('ดึงรวม: ได้ไฟล์เดียว มีหน้าที่ขอ', (await shape(r.files)) === 'PAGE 1+PAGE 5+PAGE 10',
      await shape(r.files));
    check('ดึงรวม: ไฟล์เดียวไม่ห่อ ZIP', r.files[0].mimeType === 'application/pdf');
  }

  // --- extract, separate ----------------------------------------------------
  {
    const r = await splitOperation.run(
      [file()],
      opts({ mode: 'extract-separate', pages: [1, 3, 5], zipWhenMultiple: false }),
      ctxWith(),
    );
    check('ดึงแยก: ได้ไฟล์ละหน้า', (await shape(r.files)) === 'PAGE 2 | PAGE 4 | PAGE 6',
      await shape(r.files));
    check('ดึงแยก: ตั้งชื่อเรียงเติมศูนย์',
      r.files.map((f) => f.name).join(',') === 'numbered-1.pdf,numbered-2.pdf,numbered-3.pdf',
      r.files.map((f) => f.name).join(','));
  }

  // --- every N --------------------------------------------------------------
  {
    const r = await splitOperation.run(
      [file()],
      opts({ mode: 'every-n', everyN: 4, zipWhenMultiple: false }),
      ctxWith(),
    );
    check('ทุก 4 หน้า: ท่อนสุดท้ายสั้นกว่าได้',
      (await shape(r.files)) ===
        'PAGE 1+PAGE 2+PAGE 3+PAGE 4 | PAGE 5+PAGE 6+PAGE 7+PAGE 8 | PAGE 9+PAGE 10',
      await shape(r.files));
  }

  // --- ranges ---------------------------------------------------------------
  {
    const r = await splitOperation.run(
      [file()],
      opts({ mode: 'ranges', ranges: '1-3, 5, 8-', zipWhenMultiple: false }),
      ctxWith(),
    );
    check('ช่วงกำหนดเอง: แต่ละช่วงเป็นไฟล์ของตัวเอง',
      (await shape(r.files)) === 'PAGE 1+PAGE 2+PAGE 3 | PAGE 5 | PAGE 8+PAGE 9+PAGE 10',
      await shape(r.files));

    const ctx = ctxWith();
    const over = await splitOperation.run(
      [file()],
      opts({ mode: 'ranges', ranges: '1-2, 40-50', zipWhenMultiple: false }),
      ctx,
    );
    check('ช่วงที่เกิน: ทำส่วนที่ใช้ได้ แล้วเตือนส่วนที่เกิน',
      (await shape(over.files)) === 'PAGE 1+PAGE 2' &&
        ctx.warnings.some((w) => w.code === 'W_RANGE_CLAMPED'),
      ctx.warnings.map((w) => w.code).join(' '));
  }

  // --- remove ---------------------------------------------------------------
  {
    const r = await splitOperation.run([file()], opts({ mode: 'remove', pages: [0, 1, 9] }), ctxWith());
    check('ลบหน้าที่เลือก: เหลือที่เหลือเป็นไฟล์เดียว',
      (await shape(r.files)) === 'PAGE 3+PAGE 4+PAGE 5+PAGE 6+PAGE 7+PAGE 8+PAGE 9',
      await shape(r.files));
  }

  // --- ZIP ------------------------------------------------------------------
  {
    const r = await splitOperation.run([file()], opts({ mode: 'every-n', everyN: 4 }), ctxWith());
    fs.writeFileSync(path.join(OUT, 'split-every4.zip'), r.files[0].bytes);

    check('หลายไฟล์: ห่อ ZIP ชิ้นเดียว',
      r.files.length === 1 && r.files[0].mimeType === 'application/zip', r.files[0].mimeType);
    check('ZIP มีไฟล์ครบตามแผน',
      zipNames(r.files[0].bytes).join(',') === 'numbered-1.pdf,numbered-2.pdf,numbered-3.pdf',
      zipNames(r.files[0].bytes).join(','));

    const off = await splitOperation.run(
      [file()],
      opts({ mode: 'every-n', everyN: 4, zipWhenMultiple: false }),
      ctxWith(),
    );
    check('ปิด ZIP แล้วได้ไฟล์แยก', off.files.length === 3 && off.files[0].mimeType === 'application/pdf');
  }

  // --- names with Thai and awkward characters ------------------------------
  {
    const thai: JobFile = { id: 't', name: 'ใบวางบิล 08/2026.pdf', bytes: source };
    const r = await splitOperation.run(
      [thai],
      opts({ mode: 'every-n', everyN: 5, zipWhenMultiple: false }),
      ctxWith(),
    );
    check('ชื่อไทยรอด และเครื่องหมายที่ Windows ไม่รับถูกแทน',
      r.files.every((f) => f.name.startsWith('ใบวางบิล 08-2026-') && !f.name.includes('/')),
      r.files.map((f) => f.name).join(','));
  }

  // --- refusing -------------------------------------------------------------
  {
    const none = await runJob(createJob('split', [file()], opts({ pages: [] })));
    check('ไม่เลือกหน้าเลย → ปฏิเสธ', none.error?.code === 'E_NO_PAGES_SELECTED', none.error?.code ?? 'none');

    const all = await runJob(
      createJob('split', [file()], opts({ mode: 'remove', pages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })),
    );
    check('ลบทุกหน้า → ปฏิเสธพร้อมเหตุผล', all.error?.code === 'E_NO_PAGES_SELECTED', all.error?.code ?? 'none');

    const bad = await runJob(createJob('split', [file()], opts({ mode: 'ranges', ranges: '99-120' })));
    check('ช่วงที่ใช้ไม่ได้เลย → บอกว่าเกินเอกสาร',
      bad.error?.code === 'E_RANGE_OUT_OF_BOUNDS', bad.error?.code ?? 'none');
  }

  // --- honesty --------------------------------------------------------------
  {
    const ctx = ctxWith();
    await splitOperation.run([file()], opts({ pages: [0] }), ctx);
    check('บอกว่าสารบัญไม่ติดไปด้วย',
      ctx.warnings.some((w) => w.code === 'W_BOOKMARKS_DROPPED'),
      ctx.warnings.map((w) => w.code).join(' '));
  }

  // --- whose document this is ----------------------------------------------
  //
  // A chapter cut out of a certificate is still that certificate's pages,
  // issued by whoever issued them. /Creator says who that was; only /Producer
  // is ours. And it has to hold for every piece, not just the first one out.
  {
    const cert: JobFile = { id: 'cert', name: 'certificate.pdf', bytes: await issued() };
    const r = await splitOperation.run(
      [cert],
      opts({ mode: 'every-n', everyN: 4, zipWhenMultiple: false }),
      ctxWith(),
    );
    const outs = await Promise.all(
      r.files.map((f) => PDFDocument.load(f.bytes, { updateMetadata: false })),
    );

    check('ตัดเป็นหลายไฟล์: ทุกไฟล์เก็บชื่อระบบที่ออกเอกสารไว้',
      outs.length === 3 && outs.every((d) => d.getCreator() === 'ระบบออกเอกสาร e-Certificate'),
      outs.map((d) => String(d.getCreator())).join(' | '));
    check('ตัดเป็นหลายไฟล์: ทุกไฟล์บอกว่าเราเป็นคนเขียนไฟล์ (/Producer)',
      outs.every((d) => d.getProducer() === 'Simple PDF'),
      outs.map((d) => String(d.getProducer())).join(' | '));
    check('ตัดแล้วชื่อเรื่องกับผู้แต่งยังติดไปทุกไฟล์',
      outs.every((d) => d.getTitle() === 'หนังสือรับรองการจดทะเบียน' &&
        d.getAuthor() === 'กรมพัฒนาธุรกิจการค้า'),
      outs.map((d) => String(d.getTitle())).join(' | '));
    check('ตัดแล้ววันที่สร้างยังเป็นวันที่ออกเอกสาร',
      outs.every((d) => sameSecond(d.getCreationDate(), ISSUED_ON)),
      outs.map((d) => String(d.getCreationDate())).join(' | '));
    check('ไม่มีชื่อ pdf-lib โผล่ในไฟล์ไหนเลย',
      outs.every((d) => !(d.getProducer() ?? '').includes('pdf-lib') &&
        !(d.getCreator() ?? '').includes('pdf-lib')),
      outs.map((d) => `${d.getProducer()}/${d.getCreator()}`).join(' | '));
  }

  // --- through the job layer ------------------------------------------------
  {
    const done = await runJob(createJob('split', [file()], opts({ mode: 'ranges', ranges: '2-3', zipWhenMultiple: false })));
    check('ผ่าน runJob สำเร็จ', done.state === 'done', done.state);
    check('runJob ให้หน้าที่ถูกต้อง', (await shape(done.result!.files)) === 'PAGE 2+PAGE 3',
      await shape(done.result!.files));
    check('runJob นับหน้าที่ผลิต', done.result?.stats?.pagesProcessed === 2,
      String(done.result?.stats?.pagesProcessed));
  }

  return failures;
}
