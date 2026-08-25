/**
 * Merge, checked against real documents and read back with a different library.
 *
 * pdf-lib wrote the file, so pdf-lib agreeing that the file is fine proves very
 * little — it would happily read back its own mistake. Every assertion here
 * reopens the output with pdf.js instead, which is the engine a browser
 * actually uses to show it.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { haveFixture } from './fixtures';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mergeOperation, MERGE_DEFAULTS, type MergeOptions } from '../src/engine/operations/merge';
import { createJob, runJob, jobDuration } from '../src/engine/job';
import type { JobFile, OperationContext } from '../src/engine/types';
import { appWarning, toAppError } from '../src/engine/errors';
import type { AppError } from '../src/engine/errors';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const JOB = path.join(HOME, 'Downloads', 'โฟลเดอร์งาน', 'production001');
const DOWNLOADS = path.join(HOME, 'Downloads');
const OUT = path.join(import.meta.dirname, 'out');

const SOURCES = [
  { id: 'f1', file: path.join(JOB, 'ใบแจ้งหนี้งานจริง.pdf') },
  { id: 'f2', file: path.join(JOB, 'ใบเสร็จงานจริง.pdf') },
  {
    id: 'f3',
    file: path.join(DOWNLOADS, 'ใบวางบิลไทย.pdf'),
  },
];

/** No cancellation and no UI in a headless run — just record what was reported. */
function quietCtx(): OperationContext & { seen: number[]; warnings: AppError[] } {
  const seen: number[] = [];
  const warnings: AppError[] = [];
  return {
    seen,
    warnings,
    onProgress: (percent: number) => seen.push(percent),
    throwIfAborted: () => {},
    warn: (w: AppError) => warnings.push(w),
  };
}

function opts(patch: Partial<MergeOptions> = {}): MergeOptions {
  return { ...MERGE_DEFAULTS, ...patch };
}

async function openWithPdfjs(bytes: Uint8Array) {
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
}

/** A document whose pages announce their own number, so a range check can name them. */
async function numberedPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`PAGE ${i}`, { x: 40, y: 340, size: 28, font });
  }
  return pdf.save();
}

async function textOfPage(doc: Awaited<ReturnType<typeof openWithPdfjs>>, n: number): Promise<string> {
  const content = await (await doc.getPage(n)).getTextContent();
  return content.items.map((i) => (i as { str?: string }).str ?? '').join('');
}

export async function runMergeChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  const missing = SOURCES.filter(
    (s) => !haveFixture(s.file, 'รวมไฟล์: ' + s.file.split(/[\\/]/).pop()),
  );
  if (missing.length > 0) {
    console.log('\n=== รวมไฟล์ : ข้าม (ไม่พบไฟล์ต้นทาง) ===');
    missing.forEach((m) => console.log('  ไม่พบ ' + m.file));
    return 0;
  }

  const files: JobFile[] = SOURCES.map((s) => ({
    id: s.id,
    name: path.basename(s.file),
    bytes: new Uint8Array(fs.readFileSync(s.file)),
  }));

  const pageCounts: number[] = [];
  for (const f of files) {
    pageCounts.push((await PDFDocument.load(f.bytes)).getPageCount());
  }
  const expectedTotal = pageCounts.reduce((a, b) => a + b, 0);
  console.log(`\n=== รวมไฟล์ : ${files.length} ไฟล์ (${pageCounts.join(' + ')} = ${expectedTotal} หน้า) ===`);

  // --- the ordinary merge ---------------------------------------------------
  {
    const ctx = quietCtx();
    const result = await mergeOperation.run(files, opts(), ctx);
    const bytes = result.files[0].bytes;
    fs.writeFileSync(path.join(OUT, 'merge-basic.pdf'), bytes);

    check('ได้ไฟล์เดียว', result.files.length === 1);
    check('นับหน้าตรงกับผลรวม', result.stats?.pagesProcessed === expectedTotal,
      `ได้ ${result.stats?.pagesProcessed} คาด ${expectedTotal}`);
    check('รายงานความคืบหน้าเพิ่มขึ้นเรื่อย ๆ',
      ctx.seen.length > 2 && ctx.seen.every((p: number, i: number) => i === 0 || p >= ctx.seen[i - 1]),
      ctx.seen.join(' → ') + '%');

    const doc = await openWithPdfjs(bytes);
    check('pdf.js เปิดไฟล์ผลลัพธ์ได้', doc.numPages === expectedTotal,
      `pdf.js เห็น ${doc.numPages} หน้า`);

    // Each source must still be findable, on the page it was placed at.
    const firstText = await textOfPage(doc, 1);
    const thaiText = await textOfPage(doc, pageCounts[0] + pageCounts[1] + 1);
    check('เนื้อไฟล์แรกอยู่หน้าแรก', /invoice/i.test(firstText), firstText.slice(0, 40));
    check('เนื้อใบวางบิลไทยอยู่ตำแหน่งที่ควรอยู่', thaiText.includes('ใบวางบิล'),
      thaiText.slice(0, 40));

    // --- the bookmark check that catches the encoding bug -------------------
    const outline = await doc.getOutline();
    check('มีสารบัญ', Array.isArray(outline) && outline.length === files.length,
      `ได้ ${outline?.length ?? 0} รายการ`);
    if (outline && outline.length === files.length) {
      const thaiEntry = outline[2]?.title ?? '';
      check('ชื่อสารบัญภาษาไทยไม่เพี้ยน', thaiEntry.includes('ใบวางบิล'), `"${thaiEntry}"`);
      check('ชื่อสารบัญตัดนามสกุลออก', !thaiEntry.endsWith('.pdf'), `"${thaiEntry}"`);
    }
  }

  // --- ranges ---------------------------------------------------------------
  //
  // Every real fixture here is one page, so a range over them selects "1 of 1"
  // and proves nothing at all. This builds a numbered ten-page document so the
  // check can read back *which* pages came through, not just how many.
  {
    const numbered: JobFile = { id: 'n', name: 'numbered.pdf', bytes: await numberedPdf(10) };
    const pair = [numbered, files[0]];

    const result = await mergeOperation.run(pair, opts({ pageRanges: { n: '2-4, 8' } }), quietCtx());
    fs.writeFileSync(path.join(OUT, 'merge-ranges.pdf'), result.files[0].bytes);

    const doc = await openWithPdfjs(result.files[0].bytes);
    check('ช่วงหน้าให้จำนวนหน้าถูก', doc.numPages === 4 + pageCounts[0],
      `ได้ ${doc.numPages} คาด ${4 + pageCounts[0]}`);

    const got: string[] = [];
    for (let p = 1; p <= 4; p++) got.push((await textOfPage(doc, p)).trim());
    check('ได้หน้าที่ขอมาจริง ไม่ใช่แค่จำนวนถูก', got.join(',') === 'PAGE 2,PAGE 3,PAGE 4,PAGE 8',
      got.join(', '));

    // Order inside a range spec must not depend on how it was typed.
    const shuffled = await mergeOperation.run(pair, opts({ pageRanges: { n: '8, 2-4' } }), quietCtx());
    const doc2 = await openWithPdfjs(shuffled.files[0].bytes);
    const got2: string[] = [];
    for (let p = 1; p <= 4; p++) got2.push((await textOfPage(doc2, p)).trim());
    check('ลำดับหน้าเรียงตามเอกสาร ไม่ใช่ตามที่พิมพ์', got2.join(',') === 'PAGE 2,PAGE 3,PAGE 4,PAGE 8',
      got2.join(', '));

    // An open-ended range must reach the end rather than stopping at the number.
    const tail = await mergeOperation.run(pair, opts({ pageRanges: { n: '9-' } }), quietCtx());
    const doc3 = await openWithPdfjs(tail.files[0].bytes);
    const tailPages = [(await textOfPage(doc3, 1)).trim(), (await textOfPage(doc3, 2)).trim()];
    check('ช่วงปลายเปิด "9-" ไปถึงหน้าสุดท้าย', tailPages.join(',') === 'PAGE 9,PAGE 10',
      tailPages.join(', '));
  }

  // --- a range that cannot work must stop, not silently produce less --------
  {
    let caught: AppError | null = null;
    try {
      await mergeOperation.run(files, opts({ pageRanges: { f1: '99-120' } }), quietCtx());
    } catch (e) {
      caught = e as AppError;
    }
    check('ช่วงที่เกินเอกสารถูกปฏิเสธ', caught?.code === 'E_RANGE_OUT_OF_BOUNDS',
      caught?.code ?? 'ไม่ throw');
  }

  // --- forced page size -----------------------------------------------------
  {
    const warnCtx = quietCtx();
    const result = await mergeOperation.run(files, opts({ pageSize: 'a4' }), warnCtx);
    fs.writeFileSync(path.join(OUT, 'merge-a4.pdf'), result.files[0].bytes);
    const out = await PDFDocument.load(result.files[0].bytes);
    const sizes = out.getPages().map((p) => p.getSize());
    const allA4 = sizes.every((s) => Math.abs(s.width - 595.28) < 1 && Math.abs(s.height - 841.89) < 1);
    check('บังคับ A4 แล้วทุกหน้าเป็น A4', allA4,
      sizes.map((s) => `${Math.round(s.width)}x${Math.round(s.height)}`).join(' '));
    check('เตือนว่าการบังคับขนาดทำให้ลิงก์หาย', warnCtx.warnings.length > 0);

    const doc = await openWithPdfjs(result.files[0].bytes);
    check('หน้าที่วาดใหม่ยังมีข้อความอ่านได้', (await textOfPage(doc, 1)).length > 20);
  }

  // --- refusing to run ------------------------------------------------------
  {
    let caught: AppError | null = null;
    try {
      await mergeOperation.run([files[0]], opts(), quietCtx());
    } catch (e) {
      caught = e as AppError;
    }
    check('ไฟล์เดียวถูกปฏิเสธ', caught?.code === 'E_TOO_FEW_FILES', caught?.code ?? 'ไม่ throw');
  }

  // --- metadata -------------------------------------------------------------
  {
    const result = await mergeOperation.run(files, opts({ keepMetadata: 'none', addBookmarks: false }), quietCtx());
    const doc = await openWithPdfjs(result.files[0].bytes);
    const outline = await doc.getOutline();
    check('ปิดสารบัญแล้วไม่มีสารบัญ', !outline || outline.length === 0);
  }

  // --- cancelling -----------------------------------------------------------
  //
  // The worker path stops by being terminated, which nothing here can imitate.
  // What this covers is the half that is the engine's job: that it actually
  // asks whether it should still be running, and unwinds as a cancellation
  // rather than as a corrupt-file error.
  {
    for (const stopAt of [1, 3, 6]) {
      let calls = 0;
      const ctx: OperationContext = {
        onProgress: () => {},
        warn: () => {},
        throwIfAborted: () => {
          if (++calls >= stopAt) throw new DOMException('cancelled', 'AbortError');
        },
      };

      let caught: unknown = null;
      try {
        await mergeOperation.run(files, opts({ pageSize: 'a4' }), ctx);
      } catch (e) {
        caught = e;
      }
      const asApp = toAppError(caught);
      check(`ยกเลิกที่จุดตรวจที่ ${stopAt} แล้วหยุดจริง`,
        caught instanceof DOMException && asApp.code === 'E_CANCELLED',
        asApp.code);
    }

    // A cancel must never be dressed up as a broken document.
    const wrapped = toAppError(new DOMException('cancelled', 'AbortError'));
    check('ยกเลิกไม่ถูกแปลงเป็น error ไฟล์เสีย', wrapped.code === 'E_CANCELLED', wrapped.code);
    check('ยกเลิกมีข้อความบอกผู้ใช้', appWarning('W_CANCELLED').message.th.length > 0);
  }

  // --- blame the right thing ------------------------------------------------
  //
  // A DataCloneError out of our own postMessage was being reported as "this
  // file may be damaged", which sends someone off to re-export a perfectly good
  // invoice. Our bugs have to read as our bugs.
  {
    const ours = toAppError(new DOMException('#<Object> could not be cloned.', 'DataCloneError'));
    check('บั๊กของเราไม่ถูกโยนความผิดให้ไฟล์ผู้ใช้', ours.code === 'E_INTERNAL', ours.code);

    const theirs = toAppError(new Error('Failed to parse PDF document: no xref table found'));
    check('ไฟล์เสียจริงยังบอกว่าไฟล์เสีย', theirs.code === 'E_CORRUPT', theirs.code);

    const locked = toAppError(new Error('Input document to `PDFDocument.load` is encrypted'));
    check('ไฟล์ใส่รหัสยังแยกออกได้', locked.code === 'E_ENCRYPTED', locked.code);
  }

  // --- warnings are warnings ------------------------------------------------
  {
    const ctx = quietCtx();
    await mergeOperation.run(files, opts({ pageSize: 'a4' }), ctx);
    check('คำเตือนถูกทำเครื่องหมายเป็น warning ไม่ใช่ error',
      ctx.warnings.every((w) => w.severity === 'warning'),
      ctx.warnings.map((w) => `${w.code}:${w.severity}`).join(' '));
    check('คำเตือนใช้รหัสตระกูล W_ ไม่ยืมรหัส error',
      ctx.warnings.every((w) => w.code.startsWith('W_')),
      ctx.warnings.map((w) => w.code).join(' '));
    check('คำเตือนมีทางออกให้กดปิดได้เสมอ',
      ctx.warnings.every((w) => w.actions.length > 0));
  }

  // --- the output name ------------------------------------------------------
  {
    const named = await mergeOperation.run(files, opts({ outputName: 'รวมบิลสิงหาคม' }), quietCtx());
    check('ชื่อไฟล์ไทยเติม .pdf ให้', named.files[0].name === 'รวมบิลสิงหาคม.pdf', named.files[0].name);

    const twice = await mergeOperation.run(files, opts({ outputName: 'report.pdf' }), quietCtx());
    check('ชื่อที่มี .pdf อยู่แล้วไม่ซ้ำนามสกุล', twice.files[0].name === 'report.pdf', twice.files[0].name);
  }

  // --- the job layer --------------------------------------------------------
  //
  // runJob is what the worker actually calls, so testing only the operation
  // would leave the wrapper that catches, times and collects warnings entirely
  // unexercised — which is where the last two bugs lived.
  {
    const done = await runJob(createJob('merge', files, opts()));
    check('งานที่สำเร็จมีสถานะ done', done.state === 'done', done.state);
    check('งานที่สำเร็จมีผลลัพธ์', (done.result?.files.length ?? 0) === 1);
    check('งานที่สำเร็จไม่มี error', done.error === null);
    check('งานบันทึกเวลาที่ใช้', (jobDuration(done) ?? -1) >= 0, `${jobDuration(done)}ms`);

    const warned = await runJob(createJob('merge', files, opts({ pageSize: 'a4' })));
    check('งานเก็บคำเตือนไว้แม้จะสำเร็จ', warned.state === 'done' && warned.warnings.length > 0,
      warned.warnings.map((w) => w.code).join(' '));

    const failed = await runJob(createJob('merge', [files[0]], opts()));
    check('งานที่ล้มเหลวมีสถานะ failed', failed.state === 'failed', failed.state);
    check('งานที่ล้มเหลวมี error ที่อ่านออก', failed.error?.code === 'E_TOO_FEW_FILES',
      failed.error?.code ?? 'none');

    const cancelled = await runJob(createJob('merge', files, opts()), { isAborted: () => true });
    check('งานที่ถูกยกเลิกมีสถานะ cancelled แยกจาก failed', cancelled.state === 'cancelled',
      cancelled.state);

    const unknown = await runJob(createJob('split', files, {}));
    check('operation ที่ยังไม่ลงทะเบียนล้มเหลวอย่างสุภาพ', unknown.state === 'failed',
      unknown.error?.code ?? 'none');
  }

  return failures;
}
