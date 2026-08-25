/**
 * Organize, checked by reading which pages actually came out.
 *
 * Counting pages proves almost nothing here: delete one and reorder two and the
 * count is unchanged while the document is wrong. Every check below reads the
 * page content back and names the pages it expected, in order.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';
import {
  organizeOperation,
  ORGANIZE_DEFAULTS,
  finalOrder,
  isUnchanged,
  type OrganizeOptions,
} from '../src/engine/operations/organize';
import { createJob, runJob } from '../src/engine/job';
import type { JobFile, OperationContext } from '../src/engine/types';
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

function opts(patch: Partial<OrganizeOptions> = {}): OrganizeOptions {
  return { ...ORGANIZE_DEFAULTS, ...patch };
}

/** Six pages that say which one they are, with page 3 already sideways. */
async function numbered(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 6; i++) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`PAGE ${i}`, { x: 30, y: 340, size: 26, font });
    // One page that arrives already rotated, so "add to what is there" has
    // something to be wrong about.
    if (i === 3) page.setRotation(degrees(90));
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

/**
 * A document that says who issued it, the way a real certificate does.
 *
 * Producer and Creator are deliberately different here, because that is the
 * pair the tools used to flatten into one name.
 */
async function issued(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.setTitle('หนังสือรับรองการจดทะเบียน');
  pdf.setAuthor('กรมพัฒนาธุรกิจการค้า');
  pdf.setSubject('ทะเบียนนิติบุคคล');
  pdf.setKeywords(['หนังสือรับรอง, นิติบุคคล']);
  pdf.setCreator('ระบบออกเอกสาร e-Certificate');
  pdf.setProducer('เครื่องพิมพ์ของกรมพัฒนาธุรกิจการค้า');
  pdf.setCreationDate(ISSUED_ON);
  return pdf.save();
}

/** PDF dates are written to the second, so compare them at that resolution. */
function sameSecond(a: Date | undefined, b: Date): boolean {
  return a !== undefined && Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
}

/**
 * The information dictionary as a *different* library sees it.
 *
 * pdf-lib wrote these strings, so pdf-lib agreeing they are there proves very
 * little. Thai in the info dictionary has to go in as UTF-16 with a byte-order
 * mark, and a mistake there reads back perfectly in the library that made it.
 */
async function infoOf(bytes: Uint8Array): Promise<Record<string, string>> {
  const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as unknown as {
    getMetadata(): Promise<{ info: Record<string, string> }>;
  };
  return (await doc.getMetadata()).info;
}

async function rotationsOf(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

export async function runOrganizeChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n=== จัดหน้า ===');
  const source = await numbered();
  const file = (): JobFile => ({ id: 'o', name: 'numbered.pdf', bytes: source });

  // --- the shared prediction ------------------------------------------------
  {
    check('ลำดับสุดท้าย: ค่าเริ่มต้นคือลำดับเดิม',
      finalOrder(6, opts()).join() === '0,1,2,3,4,5', finalOrder(6, opts()).join());
    check('ลำดับสุดท้าย: ลบแล้วหายจากลำดับ',
      finalOrder(6, opts({ deleted: [1, 3] })).join() === '0,2,4,5');
    check('ลำดับสุดท้าย: ลำดับที่ค้างจากไฟล์เก่าไม่ทำให้ขอหน้าที่ไม่มี',
      finalOrder(3, opts({ order: [0, 1, 2, 7, 9] })).join() === '0,1,2');
    check('ไม่เปลี่ยนอะไร = รู้ตัว', isUnchanged(6, opts()));
    check('ย้ายแล้วรู้ว่าเปลี่ยน', !isUnchanged(6, opts({ order: [1, 0, 2, 3, 4, 5] })));
    check('หมุนแล้วรู้ว่าเปลี่ยน', !isUnchanged(6, opts({ rotations: { 0: 90 } })));
  }

  // --- delete ---------------------------------------------------------------
  {
    const result = await organizeOperation.run([file()], opts({ deleted: [1, 3] }), ctxWith());
    const pages = await pagesOf(result.files[0].bytes);
    fs.writeFileSync(path.join(OUT, 'organize-deleted.pdf'), result.files[0].bytes);
    check('ลบหน้า: เหลือหน้าที่ถูกต้อง', pages.join(',') === 'PAGE 1,PAGE 3,PAGE 5,PAGE 6', pages.join(', '));
  }

  // --- reorder --------------------------------------------------------------
  {
    const result = await organizeOperation.run([file()], opts({ order: [5, 4, 3, 2, 1, 0] }), ctxWith());
    const pages = await pagesOf(result.files[0].bytes);
    check('เรียงกลับหลัง: ได้ลำดับที่ขอ',
      pages.join(',') === 'PAGE 6,PAGE 5,PAGE 4,PAGE 3,PAGE 2,PAGE 1', pages.join(', '));
  }

  // --- reorder and delete together -----------------------------------------
  {
    const result = await organizeOperation.run(
      [file()],
      opts({ order: [4, 0, 2, 1, 5, 3], deleted: [2, 5] }),
      ctxWith(),
    );
    const pages = await pagesOf(result.files[0].bytes);
    check('ย้าย+ลบพร้อมกัน: ลบตามหน้าต้นทาง ไม่ใช่ตามตำแหน่งใหม่',
      pages.join(',') === 'PAGE 5,PAGE 1,PAGE 2,PAGE 4', pages.join(', '));
  }

  // --- rotate ---------------------------------------------------------------
  {
    const result = await organizeOperation.run(
      [file()],
      opts({ rotations: { 0: 90, 1: 180, 2: 90 } }),
      ctxWith(),
    );
    const angles = await rotationsOf(result.files[0].bytes);
    fs.writeFileSync(path.join(OUT, 'organize-rotated.pdf'), result.files[0].bytes);

    check('หมุน: หน้าที่ตั้งตรงหมุนตามที่สั่ง', angles[0] === 90 && angles[1] === 180,
      angles.join(' '));
    // Page 3 arrived at 90; another 90 must land on 180, not back on 90.
    check('หมุน: บวกกับมุมที่หน้านั้นมีอยู่แล้ว', angles[2] === 180, `หน้า 3 = ${angles[2]}°`);
    check('หมุน: หน้าที่ไม่ได้สั่งไม่ขยับ', angles[3] === 0 && angles[4] === 0 && angles[5] === 0,
      angles.join(' '));
    check('หมุน: จำนวนหน้าไม่เปลี่ยน', angles.length === 6);
  }

  // --- rotation wraps -------------------------------------------------------
  {
    const result = await organizeOperation.run([file()], opts({ rotations: { 0: 270 } }), ctxWith());
    const angles = await rotationsOf(result.files[0].bytes);
    check('หมุน 270 ไม่กลายเป็นค่าติดลบ', angles[0] === 270, `${angles[0]}°`);
  }

  // --- refusing -------------------------------------------------------------
  {
    const all = await runJob(createJob('organize', [file()], opts({ deleted: [0, 1, 2, 3, 4, 5] })));
    check('ลบทุกหน้า → ปฏิเสธพร้อมเหตุผล', all.error?.code === 'E_NO_PAGES_SELECTED',
      all.error?.code ?? 'none');
  }

  // --- saying so when nothing happened -------------------------------------
  {
    const ctx = ctxWith();
    const result = await organizeOperation.run([file()], opts(), ctx);
    const pages = await pagesOf(result.files[0].bytes);
    check('ไม่เปลี่ยนอะไร: ยังได้ไฟล์ครบ', pages.length === 6);
    check('ไม่เปลี่ยนอะไร: เตือนว่าเหมือนเดิม',
      ctx.warnings.some((w) => w.code === 'W_NOTHING_CHANGED'),
      ctx.warnings.map((w) => w.code).join(' ') || 'ไม่มีคำเตือน');
  }

  // --- honesty about bookmarks ---------------------------------------------
  {
    const ctx = ctxWith();
    await organizeOperation.run([file()], opts({ deleted: [0] }), ctx);
    check('ลบหน้าแล้วบอกว่าสารบัญหาย ไม่ปล่อยให้ไปเจอเอง',
      ctx.warnings.some((w) => w.code === 'W_BOOKMARKS_DROPPED'),
      ctx.warnings.map((w) => w.code).join(' '));
  }

  // --- whose document this is ----------------------------------------------
  //
  // /Producer is the program that wrote the file — us. /Creator is the program
  // that authored the content, and turning a page sideways does not make that
  // us. Overwriting it used to lose the name of the system that issued the
  // document, silently, in a file that still opened fine.
  {
    const before = Date.now();
    const cert: JobFile = { id: 'cert', name: 'certificate.pdf', bytes: await issued() };
    const result = await organizeOperation.run([cert], opts({ rotations: { 0: 90 } }), ctxWith());
    const out = await PDFDocument.load(result.files[0].bytes, { updateMetadata: false });

    check('หมุนหน้าแล้ว ชื่อระบบที่ออกเอกสารยังอยู่ (/Creator ไม่ถูกทับ)',
      out.getCreator() === 'ระบบออกเอกสาร e-Certificate', String(out.getCreator()));
    check('แต่ชื่อโปรแกรมที่เขียนไฟล์เป็นของเรา (/Producer)',
      out.getProducer() === 'Simple PDF', String(out.getProducer()));
    check('ชื่อเรื่อง ผู้แต่ง หัวเรื่อง ติดไปด้วย',
      out.getTitle() === 'หนังสือรับรองการจดทะเบียน' &&
        out.getAuthor() === 'กรมพัฒนาธุรกิจการค้า' &&
        out.getSubject() === 'ทะเบียนนิติบุคคล',
      `${out.getTitle()} / ${out.getAuthor()} / ${out.getSubject()}`);
    check('คำสำคัญข้ามมาครบ ไม่ถูกตัดจุลภาคทิ้ง',
      out.getKeywords() === 'หนังสือรับรอง, นิติบุคคล', String(out.getKeywords()));
    check('วันที่สร้างยังเป็นวันที่ออกเอกสาร ไม่ใช่วันนี้',
      sameSecond(out.getCreationDate(), ISSUED_ON), String(out.getCreationDate()));
    check('วันที่แก้ไขคือตอนนี้ เพราะเราเพิ่งแก้',
      (out.getModificationDate()?.getTime() ?? 0) >= before - 1000,
      String(out.getModificationDate()));
    check('ไม่มีชื่อ pdf-lib โผล่ในไฟล์ที่ส่งออก',
      !(out.getProducer() ?? '').includes('pdf-lib') && !(out.getCreator() ?? '').includes('pdf-lib'),
      `${out.getProducer()} / ${out.getCreator()}`);

    const info = await infoOf(result.files[0].bytes);
    check('ผู้อ่านอีกตัว (pdf.js) เห็น /Creator กับ /Producer ตรงกัน',
      info.Creator === 'ระบบออกเอกสาร e-Certificate' && info.Producer === 'Simple PDF',
      `${info.Creator} / ${info.Producer}`);
    check('ผู้อ่านอีกตัวอ่านชื่อเรื่องภาษาไทยได้ไม่เพี้ยน',
      info.Title === 'หนังสือรับรองการจดทะเบียน', String(info.Title));
  }

  // --- a source whose own metadata is broken -------------------------------
  //
  // pdf-lib throws on a date string it cannot parse, and files in the wild do
  // carry them. Reading metadata must never turn "rotate this page" into
  // "could not open your file" — the bad field is skipped, the rest travel.
  {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    pdf.setCreator('ระบบเก่าที่เขียนวันที่ผิดรูปแบบ');
    pdf.setCreationDate(new Date());
    const info = pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict);
    info.set(PDFName.of('CreationDate'), PDFString.of('เมื่อวานนี้'));

    const broken: JobFile = { id: 'bad', name: 'broken-date.pdf', bytes: await pdf.save() };
    let caught: unknown = null;
    let out: PDFDocument | null = null;
    try {
      const result = await organizeOperation.run([broken], opts({ rotations: { 0: 90 } }), ctxWith());
      out = await PDFDocument.load(result.files[0].bytes, { updateMetadata: false });
    } catch (e) {
      caught = e;
    }
    check('วันที่เสียในต้นฉบับไม่ทำให้งานล้ม', caught === null, String(caught));
    check('และช่องอื่นยังข้ามมาได้ตามปกติ',
      out?.getCreator() === 'ระบบเก่าที่เขียนวันที่ผิดรูปแบบ', String(out?.getCreator()));
  }

  // --- through the job layer ------------------------------------------------
  {
    const done = await runJob(createJob('organize', [file()], opts({ order: [2, 1, 0], deleted: [3, 4, 5] })));
    check('ผ่าน runJob สำเร็จ', done.state === 'done', done.state);
    const pages = await pagesOf(done.result!.files[0].bytes);
    check('runJob ให้หน้าที่ถูกต้อง', pages.join(',') === 'PAGE 3,PAGE 2,PAGE 1', pages.join(', '));
    check('runJob นับหน้าที่ผลิต', done.result?.stats?.pagesProcessed === 3,
      String(done.result?.stats?.pagesProcessed));
  }

  return failures;
}
