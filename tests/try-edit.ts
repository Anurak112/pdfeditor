/**
 * Dev CLI — run one replacement against a real file and report what happened.
 *
 *   npx tsx tests/try-edit.ts <file.pdf> <find> <replace> [outFile]
 *   npx tsx tests/try-edit.ts <file.pdf> --list        # dump the text layer
 *
 * Prints the method chosen, the font it matched, and re-reads the exported
 * bytes to confirm the new text is really there and the old text is really
 * gone — the same checks `npm test` makes, but on any file you point it at.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { extractPageText, findOnPage } from '../src/lib/pdf/textExtract';
import { buildEditedPdf, type Replacement } from '../src/lib/pdf/exporter';

const [file, find, replace, outArg] = process.argv.slice(2);
if (!file || !find) {
  console.error('usage: tsx tests/try-edit.ts <file.pdf> <find> <replace> [out.pdf]');
  console.error('       tsx tests/try-edit.ts <file.pdf> --list');
  process.exit(1);
}

const load = async (bytes: Uint8Array) =>
  (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as never;

const original = new Uint8Array(fs.readFileSync(file));
const doc = await load(original);
const pageCount = (doc as unknown as { numPages: number }).numPages;

if (find === '--list') {
  for (let p = 1; p <= pageCount; p++) {
    const page = await extractPageText(doc, p);
    console.log(`--- page ${p} (${page.items.length} items) ---`);
    for (const item of page.items) {
      if (!item.text.trim()) continue;
      console.log(
        `  x=${item.x.toFixed(1).padStart(6)} y=${item.y.toFixed(1).padStart(6)} ` +
        `size=${item.fontSize.toFixed(1).padStart(5)} w=${item.width.toFixed(1).padStart(6)}  ${JSON.stringify(item.text)}`,
      );
    }
  }
  process.exit(0);
}

// locate the text on whichever page holds it
let target: { page: number; hit: Awaited<ReturnType<typeof findOnPage>>[number] } | null = null;
for (let p = 1; p <= pageCount && !target; p++) {
  const page = await extractPageText(doc, p);
  const hit = findOnPage(page, find)[0];
  if (hit) target = { page: p, hit };
}
if (!target) {
  console.error(`ไม่พบ "${find}" ในเอกสารนี้`);
  process.exit(1);
}

const { page, hit } = target;
const rep: Replacement = {
  id: 'cli', page, find, replace,
  ordinal: hit.ordinal,
  x: hit.x, y: hit.item.y, width: hit.width,
  fontSize: hit.item.fontSize, ascent: hit.item.ascent, descent: hit.item.descent,
  gapRight: hit.gapRight, itemText: hit.item.text, itemWidth: hit.item.width,
  background: { r: 1, g: 1, b: 1 }, textColor: { r: 0, g: 0, b: 0 },
};

const before = (await extractPageText(doc, page)).items.map((i) => i.text).join('');
const { bytes, reports } = await buildEditedPdf(original, [rep]);
const r = reports[0];

console.log(`\n${path.basename(file)}  page ${page}  "${find}" -> "${replace}"`);
console.log(`  method=${r.method}  font=${r.fontName}  widthErr=${r.fontWidthError?.toFixed(5) ?? '—'}pt  fit=${(r.fitScale * 100).toFixed(1)}%`);
r.notes.forEach((n) => console.log(`    · ${n}`));

const outDoc = await load(bytes);
const outPage = await extractPageText(outDoc, page);
const after = outPage.items.map((i) => i.text).join('');
const moved = findOnPage(outPage, replace)[0];

const say = (label: string, ok: boolean, detail = '') =>
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

say('ข้อความใหม่อยู่ในไฟล์', after.includes(replace));
say('ข้อความเดิมหายจาก text layer', !after.includes(find));
say('ข้อความอื่นคงเดิม', before.replace(find, replace) === after,
  before.replace(find, replace) === after ? '' : 'เรียงลำดับหรือช่องว่างเปลี่ยน');
if (moved) {
  const dx = Math.abs(moved.x - hit.x);
  const dy = Math.abs(moved.item.y - hit.item.y);
  say('ตำแหน่งตรงเดิม (< 0.01pt)', dx < 0.01 && dy < 0.01, `dx=${dx.toFixed(4)} dy=${dy.toFixed(4)}`);
  say('ไม่ชนข้อความถัดไป', moved.gapRight > 0,
    `เดิมเว้น ${fmt(hit.gapRight)} ใหม่เว้น ${fmt(moved.gapRight)}`);
}

const out = outArg ?? path.join(import.meta.dirname, 'out', path.basename(file).replace(/\.pdf$/i, '-cli.pdf'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bytes);
console.log(`  -> ${out}  (${original.length} -> ${bytes.length} bytes)`);

function fmt(g: number): string {
  return Number.isFinite(g) ? g.toFixed(2) + 'pt' : 'ไม่มีข้อความต่อท้าย';
}
