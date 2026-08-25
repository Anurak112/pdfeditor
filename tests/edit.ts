/**
 * Edit, checked against the claim the whole tool rests on.
 *
 * "We change the text in the file, not a box painted over it" is either true or
 * it is marketing. The only way to tell is to read the text layer of the output
 * back and confirm the old value is not still sitting in it — which is exactly
 * what a competitor's overlay leaves behind.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { haveFixture } from './fixtures';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { editOperation, EDIT_DEFAULTS, countMatches, type EditOptions } from '../src/engine/operations/edit';
import { createJob, runJob } from '../src/engine/job';
import { readAllPages } from '../src/lib/editor/replaceJob';
import type { JobFile, OperationContext, PdfjsOpener } from '../src/engine/types';
import type { AppError } from '../src/engine/errors';
import { mixedPlacementPdf } from './synthetic';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const JOB = path.join(HOME, 'Downloads', 'โฟลเดอร์งาน', 'production001');
const DOWNLOADS = path.join(HOME, 'Downloads');
const OUT = path.join(import.meta.dirname, 'out');

/**
 * The Node host's pdf.js.
 *
 * The app hands in a bundler-built one instead. That difference is the entire
 * reason the operation takes an opener rather than importing pdf.js itself.
 */
const openPdfjs: PdfjsOpener = async (bytes) => {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = (await task.promise) as never;
  return { doc, close: () => void task.destroy() };
};

function ctxWith(): OperationContext & { warnings: AppError[]; seen: number[] } {
  const warnings: AppError[] = [];
  const seen: number[] = [];
  return {
    warnings,
    seen,
    onProgress: (p: number) => seen.push(p),
    throwIfAborted: () => {},
    warn: (w: AppError) => warnings.push(w),
    openPdfjs,
  };
}

function opts(patch: Partial<EditOptions> = {}): EditOptions {
  return { ...EDIT_DEFAULTS, ...patch };
}

async function textOf(bytes: Uint8Array, pageNumber = 1): Promise<string> {
  const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as never;
  const content = await (await (doc as { getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }).getPage(pageNumber)).getTextContent();
  return content.items.map((i) => (i as { str?: string }).str ?? '').join('');
}

/**
 * A multi-page fixture built from a real invoice, not synthesised.
 *
 * Synthesising one was the obvious move and it is a trap: a font embedded by
 * pdf-lib comes out with no usable ToUnicode map, so pdf.js reads
 * "CCCC-CCC CCCC" where the page says "CODE-777 here". The test would then be
 * measuring the fixture rather than the editor. Real documents — anything out
 * of Stripe, Word or jsPDF — carry a proper map, so the fixture is three copies
 * of one.
 */
async function tripled(sourceBytes: Uint8Array): Promise<Uint8Array> {
  const source = await PDFDocument.load(sourceBytes);
  const out = await PDFDocument.create();
  for (let i = 0; i < 3; i++) {
    const [page] = await out.copyPages(source, [0]);
    out.addPage(page);
  }
  return out.save();
}

/** The same content with a standard-14 font, which cannot be edited natively. */
async function standardFontPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 300]);
  page.drawText('CODE-777 here', { x: 40, y: 200, size: 14, font });
  return pdf.save();
}

/** A page with graphics and no text at all — what a scan looks like to a text layer. */
async function scanLikePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.drawRectangle({ x: 20, y: 20, width: 360, height: 260, color: rgb(0.8, 0.8, 0.85) });
  return pdf.save();
}

export async function runEditChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  /** A throw is one failed check, not the end of the suite. */
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e as Error)?.message ?? String(e);
      check(label, false, `throw: ${code}`);
    }
  };
  void attempt;
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n=== แก้ข้อความ ===');

  // --- the claim, on a real Stripe invoice ---------------------------------
  const stripe = path.join(JOB, 'ใบแจ้งหนี้งานจริง.pdf');
  if (haveFixture(stripe, 'แก้ข้อความ: ใบแจ้งหนี้ Stripe')) {
    const file: JobFile = { id: 's', name: 'ใบแจ้งหนี้งานจริง.pdf', bytes: new Uint8Array(fs.readFileSync(stripe)) };
    const ctx = ctxWith();
    const result = await editOperation.run([file], opts({ find: '246/8', replace: '135/7' }), ctx);
    const bytes = result.files[0].bytes;
    fs.writeFileSync(path.join(OUT, 'op-edit-stripe.pdf'), bytes);

    const after = await textOf(bytes);
    check('ข้อความใหม่อยู่ในไฟล์', after.includes('135/7'));
    check('ข้อความเดิมหายจาก text layer จริง', !after.includes('246/8'),
      'นี่คือข้อที่คู่แข่งทำไม่ได้');
    check('ข้อความอื่นในหน้ายังอยู่', after.includes('Anthropic') && after.includes('San Francisco'));
    check('นับจำนวนจุดที่แก้', (result.stats?.replacements ?? 0) > 0, String(result.stats?.replacements));
  } else {
    console.log('  ข้าม Stripe (ไม่พบไฟล์)');
  }

  // --- the Thai bill --------------------------------------------------------
  //
  // The invoice number rather than the address: this file gets edited by hand
  // between runs, so a hardcoded address value goes stale and the test starts
  // reporting an engine failure for a fixture that simply moved on.
  const thai = path.join(DOWNLOADS, 'ใบวางบิลไทย.pdf');
  if (haveFixture(thai, 'แก้ข้อความ: ใบวางบิลไทย')) {
    const file: JobFile = { id: 't', name: 'ใบวางบิลไทย.pdf', bytes: new Uint8Array(fs.readFileSync(thai)) };
    const before = await textOf(file.bytes);
    check('ใบวางบิลไทย: มีเลขที่ใบวางบิลให้แก้', before.includes('INV-0000-000'));

    const result = await editOperation.run(
      [file],
      opts({ find: 'INV-0000-000', replace: 'INV-0000-042' }),
      ctxWith(),
    );
    const after = await textOf(result.files[0].bytes);
    fs.writeFileSync(path.join(OUT, 'op-edit-thai.pdf'), result.files[0].bytes);

    check('ใบวางบิลไทย: ค่าใหม่เข้าไปแล้ว', after.includes('INV-0000-042'));
    check('ใบวางบิลไทย: ค่าเดิมหายจาก text layer', !after.includes('INV-0000-000'));
    check('ใบวางบิลไทย: ข้อความไทยอื่นไม่เสียหาย', after.includes('ใบวางบิล') && after.includes('ตำบลตัวอย่าง'));
    check('ชื่อไฟล์ผลลัพธ์เป็นไทยได้', result.files[0].name.includes('แก้แล้ว'), result.files[0].name);
  } else {
    console.log('  ข้ามใบวางบิลไทย (ไม่พบไฟล์)');
  }

  // --- scope: one page must not touch the others ---------------------------
  const haveStripe = fs.existsSync(stripe);
  const tripledBytes = haveStripe ? await tripled(new Uint8Array(fs.readFileSync(stripe))) : null;

  if (tripledBytes) {
    const bytes = tripledBytes;
    const file: JobFile = { id: 'm', name: 'marked.pdf', bytes };

    const scoped = await editOperation.run(
      [file],
      opts({ find: '246/8', replace: '135/7', scope: 'this-page', page: 2 }),
      ctxWith(),
    );
    const out = scoped.files[0].bytes;
    const [p1, p2, p3] = [await textOf(out, 1), await textOf(out, 2), await textOf(out, 3)];

    check('แก้เฉพาะหน้าที่ระบุ: หน้า 2 มีค่าใหม่', p2.includes('135/7'));
    // The assertion that matters: the old value must be gone, not merely
    // covered. Checking only for the new one passes even for an overlay.
    check('แก้เฉพาะหน้าที่ระบุ: หน้า 2 ค่าเดิมหายจริง', !p2.includes('246/8'));
    check('แก้เฉพาะหน้าที่ระบุ: หน้า 1 ไม่ถูกแตะ', p1.includes('246/8'));
    check('แก้เฉพาะหน้าที่ระบุ: หน้า 3 ไม่ถูกแตะ', p3.includes('246/8'));
    check('นับเฉพาะจุดในขอบเขต', scoped.stats?.replacements === 1, String(scoped.stats?.replacements));

    const every = await editOperation.run(
      [file],
      opts({ find: '246/8', replace: '135/7', scope: 'all-pages' }),
      ctxWith(),
    );
    check('ทุกหน้า: แก้ครบ 3 จุด', every.stats?.replacements === 3, String(every.stats?.replacements));
  }

  // --- counting before running ---------------------------------------------
  if (tripledBytes) {
    const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(tripledBytes) }).promise) as never;
    const pages = await readAllPages(doc);
    const found = countMatches(pages, '246/8');
    check('นับจำนวนที่เจอได้ก่อนลงมือ', found.total === 3 && found.pages.length === 3,
      `${found.total} จุด ใน ${found.pages.length} หน้า`);
    const none = countMatches(pages, 'NOT-PRESENT');
    check('ไม่เจอก็บอกว่าศูนย์', none.total === 0);
  }

  // --- a standard-14 font, which is not embedded ---------------------------
  //
  // Worth pinning down because the assumption was that this could only be
  // painted over. It cannot: V2 taught the exporter one-byte simple fonts, so
  // this edits in place like anything else, and no overlay warning should fire.
  {
    const file: JobFile = { id: 'std', name: 'standard-font.pdf', bytes: await standardFontPdf() };
    const ctx = ctxWith();
    const result = await editOperation.run([file], opts({ find: 'CODE-777', replace: 'CODE-999' }), ctx);
    const after = await textOf(result.files[0].bytes);

    check('ฟอนต์ standard-14: แก้ได้', after.includes('CODE-999'), after);
    check('ฟอนต์ standard-14: ค่าเดิมหายจริง ไม่ใช่วาดทับ', !after.includes('CODE-777'), after);
    check('ฟอนต์ standard-14: ไม่เตือนวาดทับโดยไม่จำเป็น',
      !ctx.warnings.some((w) => w.code === 'W_EDIT_OVERLAY'),
      ctx.warnings.map((w) => w.code).join(' ') || 'ไม่มีคำเตือน');
  }

  // --- the erase path must not be mistaken for overlay ---------------------
  //
  // Two different fallbacks with two different consequences: erase removes the
  // old text and redraws, overlay leaves it underneath. Reporting erase as
  // overlay would warn people about a problem they do not have — and the
  // warning is only worth anything if it is rare and true.
  {
    const file: JobFile = { id: 'mix', name: 'mixed.pdf', bytes: await mixedPlacementPdf() };
    const ctx = ctxWith();
    const result = await editOperation.run([file], opts({ find: '246/8', replace: '135/799' }), ctx);
    const after = await textOf(result.files[0].bytes);

    check('เส้นทาง erase: ค่าใหม่เข้าไป', after.includes('135/799'), after.slice(0, 60));
    check('เส้นทาง erase: ค่าเดิมหายจริง', !after.includes('246/8'));
    check('เส้นทาง erase: ไม่ถูกรายงานว่าเป็นการวาดทับ',
      !ctx.warnings.some((w) => w.code === 'W_EDIT_OVERLAY'),
      ctx.warnings.map((w) => w.code).join(' ') || 'ไม่มีคำเตือน');
  }

  // --- batch ----------------------------------------------------------------
  if (tripledBytes) {
    const a: JobFile = { id: 'a', name: 'first.pdf', bytes: tripledBytes };
    const b: JobFile = { id: 'b', name: 'second.pdf', bytes: tripledBytes };

    const both = await editOperation.run([a, b], opts({ find: '246/8', replace: '135/7' }), ctxWith());
    check('สองไฟล์ที่แก้ได้ทั้งคู่ → ห่อ ZIP', both.files[0].mimeType === 'application/zip',
      both.files[0].mimeType);
    check('ZIP เป็นชิ้นเดียว', both.files.length === 1);
    check('นับรวมทุกไฟล์', both.stats?.replacements === 6, String(both.stats?.replacements));

    const other = await PDFDocument.create();
    const font = await other.embedFont(StandardFonts.Helvetica);
    other.addPage([300, 200]).drawText('nothing to find here', { x: 20, y: 150, size: 12, font });
    const missing: JobFile = { id: 'c', name: 'has-not.pdf', bytes: await other.save() };

    const ctx = ctxWith();
    const one = await editOperation.run([a, missing], opts({ find: '246/8', replace: '135/7' }), ctx);
    check('เจอไฟล์เดียว → คืน PDF เปล่า ๆ ไม่ห่อ ZIP ให้เก้อ',
      one.files[0].mimeType === 'application/pdf', one.files[0].mimeType);
    check('ไฟล์ที่ไม่เจอข้อความถูกเตือน ไม่ใช่เงียบ',
      ctx.warnings.some((w) => w.code === 'W_NO_MATCH_IN_FILE'),
      ctx.warnings.map((w) => w.code).join(' '));
  }

  // --- refusing, clearly ----------------------------------------------------
  if (tripledBytes) {
    const file: JobFile = { id: 'm', name: 'marked.pdf', bytes: tripledBytes };

    const notFound = await runJob(createJob('edit', [file], opts({ find: 'ABSENT', replace: 'X' })), { openPdfjs });
    check('ไม่เจอข้อความ → E_TEXT_NOT_FOUND', notFound.error?.code === 'E_TEXT_NOT_FOUND',
      notFound.error?.code ?? 'none');

    const empty = await runJob(createJob('edit', [file], opts({ find: '', replace: 'X' })), { openPdfjs });
    check('ไม่ใส่คำค้น → บอกว่าตัวเลือกไม่ครบ', empty.error?.code === 'E_BAD_OPTIONS',
      empty.error?.code ?? 'none');

    const scan: JobFile = { id: 'sc', name: 'scan.pdf', bytes: await scanLikePdf() };
    const scanned = await runJob(createJob('edit', [scan], opts({ find: 'anything', replace: 'X' })), { openPdfjs });
    check('ไฟล์สแกน → บอกว่าไม่มี text layer ไม่ใช่ "ไม่พบข้อความ"',
      scanned.error?.code === 'E_NO_TEXT_LAYER', scanned.error?.code ?? 'none');

    // The host that cannot load pdf.js must be told, not left to fail obscurely.
    const noOpener = await runJob(createJob('edit', [file], opts({ find: '246/8', replace: 'X' })));
    check('host ที่ไม่มี pdf.js → บอกตรง ๆ ว่าเป็นความผิดเรา', noOpener.error?.code === 'E_INTERNAL',
      noOpener.error?.code ?? 'none');
  }

  // --- the job layer end to end --------------------------------------------
  if (tripledBytes) {
    const file: JobFile = { id: 'm', name: 'marked.pdf', bytes: tripledBytes };
    const done = await runJob(createJob('edit', [file], opts({ find: '246/8', replace: '135/7' })), { openPdfjs });
    check('ผ่าน runJob ได้ผลลัพธ์', done.state === 'done' && done.result?.files.length === 1, done.state);
    check('runJob รายงานจำนวนจุดที่แก้', done.result?.stats?.replacements === 3,
      String(done.result?.stats?.replacements));
  }

  return failures;
}
