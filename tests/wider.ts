/**
 * Whole-document checks against the other producers we care about.
 *
 * `run.ts` covers the two Stripe files glyph by glyph; this covers the shapes
 * that used to be unsupported — one-byte simple fonts written as literal
 * `(text) Tj`, and a find/replace that has to sweep several pages at once.
 * Both go through the same collect → build path the "ทุกหน้า" switch uses.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import { docText, fixture, haveFixture } from './fixtures';
import path from 'node:path';
import { extractPageText, findOnPage, type PageText, type PdfTextItem } from '../src/lib/pdf/textExtract';
import { buildEditedPdf } from '../src/lib/pdf/exporter';
import { collectReplacements } from '../src/lib/editor/replaceJob';

const DOWNLOADS = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Downloads');
const OUT = path.join(import.meta.dirname, 'out');

export interface Fixture {
  file: string;
  find: string;
  replace: string;
  /** The method the editor must manage — anything weaker is a regression. */
  method: 'native' | 'erase' | 'overlay';
  note: string;
}

export const WIDER_FIXTURES: Fixture[] = [
  {
    file: fixture('thaiBill'),
    find: docText('thaiBill', 'address') ?? '',
    replace: '246/8',
    method: 'native',
    note: 'ฟอนต์ 1 ไบต์ + ข้อความแบบ (…) Tj — เดิมทำได้แค่ทับ',
  },
  {
    file: fixture('thaiBill'),
    find: docText('thaiBill', 'address') ?? '',
    replace: '1234/56',
    method: 'native',
    note: 'ยาวไม่เท่าเดิม — ต้องยังแก้ในไฟล์ตรง ๆ ได้',
  },
  {
    file: fixture('invoiceWithLogo'),
    find: 'Thai dubbing',
    // deliberately not a superset of the needle, so "gone from the file" means something
    replace: 'TH voice-over',
    method: 'native',
    note: 'หลายจุด กระจาย 2 หน้า · ยาวไม่เท่าเดิม',
  },
];

const load = async (bytes: Uint8Array) =>
  (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as never;

async function readPages(doc: never, count: number): Promise<PageText[]> {
  const pages: PageText[] = [];
  for (let n = 1; n <= count; n++) pages.push(await extractPageText(doc, n));
  return pages;
}

/** Run every fixture that exists on this machine; returns the failure count. */
export async function runWiderFixtures(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  for (const fx of WIDER_FIXTURES) {
    if (!haveFixture(fx.file, `เอกสารกว้าง: ${path.basename(fx.file)}`)) continue;
    console.log(`\n=== ${path.basename(fx.file)} : ทั้งไฟล์ "${fx.find}" -> "${fx.replace}" ===`);
    console.log(`  (${fx.note})`);

    const original = new Uint8Array(fs.readFileSync(fx.file));
    const doc = await load(original);
    const pageCount = (doc as unknown as { numPages: number }).numPages;
    const pages = await readPages(doc, pageCount);
    const before = pages.map((p) => p.items.map((i) => i.text).join('')).join('\n');

    const replacements = await collectReplacements(pages, fx.find, fx.replace);
    check(`พบ "${fx.find}" ในไฟล์`, replacements.length > 0, `${replacements.length} จุด · ${pageCount} หน้า`);
    if (replacements.length === 0) continue;

    const { bytes, reports } = await buildEditedPdf(original, replacements);
    const methods = [...new Set(reports.map((r) => r.method))];
    const fonts = [...new Set(reports.map((r) => r.fontName))];
    console.log(`  method=${methods.join(',')}  font=${fonts.join(',')}`);
    reports[0].notes.forEach((n) => console.log(`    · ${n}`));

    check('ใช้วิธีที่ตั้งเป้าทุกจุด', methods.length === 1 && methods[0] === fx.method,
      `ได้ ${methods.join(',')} · ต้องการ ${fx.method}`);
    check('ไม่เหลือข้อความเดิมใน text layer', reports.every((r) => r.originalRemoved));

    const outDoc = await load(bytes);
    const outPages = await readPages(outDoc, pageCount);
    const after = outPages.map((p) => p.items.map((i) => i.text).join('')).join('\n');

    check('แก้ครบทุกจุด', !after.includes(fx.find));
    check('ข้อความอื่นคงเดิมทุกตัว', before.split(fx.find).join(fx.replace) === after);

    // every replacement must still sit on its original baseline
    let worstDx = 0;
    let worstDy = 0;
    for (const rep of replacements) {
      const moved = findOnPage(outPages[rep.page - 1], fx.replace)[rep.ordinal];
      if (!moved) continue;
      worstDx = Math.max(worstDx, Math.abs(moved.x - rep.x));
      worstDy = Math.max(worstDy, Math.abs(moved.item.y - rep.y));
    }
    check('ทุกจุดอยู่ตำแหน่งเดิม (< 0.01pt)', worstDx < 0.01 && worstDy < 0.01,
      `dx=${worstDx.toFixed(4)} dy=${worstDy.toFixed(4)}`);

    fs.mkdirSync(OUT, { recursive: true });
    const tag = fx.replace.replace(/[^0-9A-Za-z]+/g, '_').slice(0, 20);
    const outFile = path.join(OUT, path.basename(fx.file).replace(/\.pdf$/i, `-all-${tag}.pdf`));
    fs.writeFileSync(outFile, bytes);
    console.log(`  -> ${outFile}  (${original.length} -> ${bytes.length} bytes)`);
  }

  failures += await checkPushMode();
  return failures;
}

/**
 * "Push the following text" must move the rest of that line and nothing else.
 *
 * The check compares every text item before and after: items to the right on
 * the same line move by the width the replacement gained; every other item on
 * the page has to stay exactly where it was.
 */
async function checkPushMode(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  const file = WIDER_FIXTURES[0].file;
  if (!haveFixture(file, 'โหมดดันข้อความ')) return 0;

  const find = docText('thaiBill', 'address');
  const replace = '1234/56';
  if (!find) {
    console.log('  (ไม่รู้เลขที่อยู่บนเอกสารนี้ — ตั้งได้ที่ tests/fixtures.local.json)');
    return 0;
  }
  console.log(`
=== ${path.basename(file)} : โหมดดันข้อความ "${find}" -> "${replace}" ===`);

  const original = new Uint8Array(fs.readFileSync(file));
  const pagesBefore = await readPages(await load(original), 1);
  const target = findOnPage(pagesBefore[0], find)[0];
  check('พบข้อความที่จะแก้', !!target);
  if (!target) return failures;

  const replacements = await collectReplacements(pagesBefore, find, replace, undefined, 'push');
  const { bytes, reports } = await buildEditedPdf(original, replacements);
  const report = reports[0];
  console.log(`  method=${report.method}  fit=${(report.fitScale * 100).toFixed(1)}%  pushed=${report.pushed.toFixed(2)}pt`);
  report.notes.forEach((n) => console.log(`    · ${n}`));

  check('ไม่บีบตัวอักษร', report.fitScale > 0.999, `fit=${(report.fitScale * 100).toFixed(1)}%`);
  check('รายงานว่าดันข้อความ', report.pushed > 0, `${report.pushed.toFixed(2)} pt`);

  const pagesAfter = await readPages(await load(bytes), 1);
  // pair items by reading order: the same words repeat all over an invoice, so
  // matching on text alone pairs the wrong ones and invents huge moves
  const afterItems = pagesAfter[0].items;
  check('จำนวนชิ้นข้อความเท่าเดิม', afterItems.length === pagesBefore[0].items.length,
    `${pagesBefore[0].items.length} -> ${afterItems.length}`);

  const sameLine = (item: PdfTextItem) => Math.abs(item.y - target.item.y) < 1;
  const rightOf = (item: PdfTextItem) => item.x > target.x + target.width - 0.01;

  let movedRight = 0;
  let wrongMove = 0;
  let worstOther = 0;
  pagesBefore[0].items.forEach((before, i) => {
    if (before.text === find) return;
    const after = afterItems[i];
    if (!after || after.text !== before.text) return;
    const dx = after.x - before.x;
    if (sameLine(before) && rightOf(before)) {
      if (Math.abs(dx - report.pushed) < 0.05) movedRight++;
      else wrongMove++;
    } else {
      worstOther = Math.max(worstOther, Math.abs(dx));
    }
  });

  check('ข้อความหลังจุดแก้ในบรรทัดเดียวกันเลื่อนพอดี', movedRight > 0 && wrongMove === 0,
    `เลื่อนถูก ${movedRight} ชิ้น · ผิด ${wrongMove} ชิ้น`);
  check('ข้อความอื่นทั้งหน้าไม่ขยับ', worstOther < 0.01, `มากสุด ${worstOther.toFixed(4)} pt`);

  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, path.basename(file).replace(/\.pdf$/i, '-push.pdf'));
  fs.writeFileSync(outFile, bytes);
  console.log(`  -> ${outFile}`);
  return failures;
}
