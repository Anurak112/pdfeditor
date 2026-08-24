/**
 * Checks for the paths the real-file fixtures never reach.
 *
 * Two of them existed but were untested, which is how a bug can sit in plain
 * sight: `pushed` once reported a distance nothing had actually moved, because
 * no test ever ran push against a file where pushing needs a matrix edit.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { extractPageText, findOnPage, type PageText, type PdfTextItem } from '../src/lib/pdf/textExtract';
import { buildEditedPdf } from '../src/lib/pdf/exporter';
import { collectReplacements } from '../src/lib/editor/replaceJob';
import { mixedPlacementPdf, separateRunsPdf } from './synthetic';

const OUT = path.join(import.meta.dirname, 'out');
const load = async (b: Uint8Array) => (await pdfjsLib.getDocument({ data: new Uint8Array(b) }).promise) as never;

async function firstPage(bytes: Uint8Array): Promise<PageText> {
  return extractPageText(await load(bytes), 1);
}

function itemAt(page: PageText, text: string): PdfTextItem | undefined {
  return page.items.find((i) => i.text.includes(text));
}

export async function runPathChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  // --- erase path -----------------------------------------------------------
  console.log('\n=== ไฟล์สังเคราะห์ : ข้อความวางปนสองวิธี "246/8" -> "135/7" ===');
  console.log('  (บังคับให้ตกไปเส้นทาง "ลบของเดิม + วาดใหม่")');
  {
    const original = await mixedPlacementPdf();
    const before = await firstPage(original);
    check('พบข้อความในไฟล์สังเคราะห์', findOnPage(before, '246/8').length === 1);

    const reps = await collectReplacements([before], '246/8', '135/799');
    const { bytes, reports } = await buildEditedPdf(original, reps);
    const r = reports[0];
    console.log(`  method=${r.method}  font=${r.fontName}  fit=${(r.fitScale * 100).toFixed(1)}%`);
    r.notes.forEach((n) => console.log(`    · ${n}`));

    check('ใช้เส้นทาง erase (ไม่ใช่ overlay)', r.method === 'erase', `ได้ ${r.method}`);
    check('ไม่เหลือข้อความเดิมใน text layer', r.originalRemoved);

    const after = await firstPage(bytes);
    const text = after.items.map((i) => i.text).join('');
    check('ข้อความใหม่อยู่ในไฟล์', text.includes('135/799'));
    check('ข้อความเดิมหายไปจริง', !text.includes('246/8'));
    check('ข้อความอื่นยังอยู่', text.includes('Sukhumvit Rd'));

    const moved = findOnPage(after, '135/799')[0];
    if (moved) {
      const dx = Math.abs(moved.x - findOnPage(before, '246/8')[0].x);
      const dy = Math.abs(moved.item.y - findOnPage(before, '246/8')[0].item.y);
      check('วาดทับตำแหน่งเดิม (< 0.5pt)', dx < 0.5 && dy < 0.5, `dx=${dx.toFixed(3)} dy=${dy.toFixed(3)}`);
    }
    fs.writeFileSync(path.join(OUT, 'synthetic-erase.pdf'), bytes);
  }

  // --- push that needs a matrix edit ---------------------------------------
  console.log('\n=== ไฟล์สังเคราะห์ : ดันข้อความที่วางด้วย Tm ของตัวเอง ===');
  {
    const original = await separateRunsPdf();
    const before = await firstPage(original);
    const neighbourBefore = itemAt(before, 'Sukhumvit');
    const otherLineBefore = itemAt(before, 'Bangkok');

    const reps = await collectReplacements([before], '246/8', '1234/5678', undefined, 'push');
    const { bytes, reports } = await buildEditedPdf(original, reps);
    const r = reports[0];
    console.log(`  method=${r.method}  fit=${(r.fitScale * 100).toFixed(1)}%  pushed=${r.pushed.toFixed(2)}pt`);
    r.notes.forEach((n) => console.log(`    · ${n}`));

    check('แก้ในไฟล์ตรง ๆ', r.method === 'native', `ได้ ${r.method}`);
    check('ไม่บีบตัวอักษร', r.fitScale > 0.999);
    check('รายงานว่าดันข้อความ', r.pushed > 0, `${r.pushed.toFixed(2)} pt`);

    const after = await firstPage(bytes);
    const neighbourAfter = itemAt(after, 'Sukhumvit');
    const otherLineAfter = itemAt(after, 'Bangkok');
    const neighbourDx = neighbourBefore && neighbourAfter ? neighbourAfter.x - neighbourBefore.x : NaN;
    const otherDx = otherLineBefore && otherLineAfter ? Math.abs(otherLineAfter.x - otherLineBefore.x) : NaN;

    check('เพื่อนบ้านบรรทัดเดียวกันเลื่อนเท่าที่รายงาน', Math.abs(neighbourDx - r.pushed) < 0.05,
      `เลื่อนจริง ${neighbourDx.toFixed(2)} pt · รายงาน ${r.pushed.toFixed(2)} pt`);
    check('บรรทัดอื่นไม่ขยับ', otherDx < 0.01, `${otherDx.toFixed(4)} pt`);
    fs.writeFileSync(path.join(OUT, 'synthetic-push.pdf'), bytes);
  }

  // --- same file, squeeze: the neighbour must NOT move ---------------------
  // the replacement is deliberately wider than the gap, so tightening is the
  // only way it fits — a shorter one would legitimately need no squeezing
  console.log('\n=== ไฟล์สังเคราะห์ : โหมดบีบ ต้องบีบจริงและไม่ดันใคร ===');
  {
    const original = await separateRunsPdf();
    const before = await firstPage(original);
    const neighbourBefore = itemAt(before, 'Sukhumvit');

    const reps = await collectReplacements([before], '246/8', '1234/5678 Soi 12 Bangna', undefined, 'squeeze');
    const { bytes, reports } = await buildEditedPdf(original, reps);
    const r = reports[0];
    console.log(`  method=${r.method}  fit=${(r.fitScale * 100).toFixed(1)}%  pushed=${r.pushed.toFixed(2)}pt`);

    check('บีบให้พอดีจริง', r.fitScale < 0.999, `fit=${(r.fitScale * 100).toFixed(1)}%`);
    check('ไม่รายงานว่าดัน', r.pushed === 0);

    // measure the line's right edge, not one item's x: once the new text sits
    // close to its neighbour pdf.js reads them as a single item, which moves
    // the "neighbour" x without anything on the page having moved
    const after = await firstPage(bytes);
    const rightEdge = (page: PageText) => Math.max(
      ...page.items.filter((i) => Math.abs(i.y - 100) < 1).map((i) => i.x + i.width),
    );
    const edgeDx = Math.abs(rightEdge(after) - rightEdge(before));
    check('ขอบขวาของบรรทัดไม่ขยับ', edgeDx < 0.01, `${edgeDx.toFixed(4)} pt`);
    check('เพื่อนบ้านยังอยู่ในบรรทัดเดิม', !!itemAt(after, 'Sukhumvit'));
    void neighbourBefore;
  }

  return failures;
}
