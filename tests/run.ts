/**
 * Headless check of the editing core against real PDFs — run with `npm test`.
 *
 * It asserts the thing that actually matters: the exported file says the new
 * address, does NOT still contain the old one anywhere in its text, and every
 * other string on the page survives byte-for-byte.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { extractPageText, findOnPage } from '../src/lib/pdf/textExtract';
import { buildEditedPdf, type Replacement } from '../src/lib/pdf/exporter';
import { runWiderFixtures } from './wider';
import { runPathChecks } from './paths';
import { runMergeChecks } from './merge';
import { runEditChecks } from './edit';
import { runOrganizeChecks } from './organize';
import { runSplitChecks } from './split';
import { runConvertChecks } from './convert';
import { runCompressChecks } from './compress';
import { runUnlockChecks } from './unlock';
import { runWorkerChecks } from './workers';
import { runPwaChecks } from './pwa';
import { haveFixture, reportFixtureSkips } from './fixtures';

// the real job: the two Stripe documents that need the address fixed
const JOB_DIR = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '.',
  'Downloads', 'โฟลเดอร์งาน', 'production001',
);
const JOB_FILES = ['ใบแจ้งหนี้งานจริง.pdf', 'ใบเสร็จงานจริง.pdf'];
const OUT = path.join(import.meta.dirname, 'out');

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function load(bytes: Uint8Array) {
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise as never;
}

async function textOf(bytes: Uint8Array, pageNumber = 1): Promise<string> {
  const doc = await load(bytes);
  const page = await extractPageText(doc, pageNumber);
  return page.items.map((i) => i.text).join('');
}

async function runFile(file: string, find: string, replace: string) {
  console.log(`\n=== ${path.basename(file)} : "${find}" -> "${replace}" ===`);
  const original = new Uint8Array(fs.readFileSync(file));
  const doc = await load(original);
  const pageText = await extractPageText(doc, 1);
  const hits = findOnPage(pageText, find);
  check(`พบ "${find}" ในหน้า 1`, hits.length > 0, `${hits.length} จุด`);
  if (hits.length === 0) return;

  const hit = hits[0];
  const rep: Replacement = {
    id: 'r1',
    page: 1,
    find,
    replace,
    ordinal: hit.ordinal,
    x: hit.x,
    y: hit.item.y,
    width: hit.width,
    fontSize: hit.item.fontSize,
    ascent: hit.item.ascent,
    descent: hit.item.descent,
    gapRight: hit.gapRight,
    itemText: hit.item.text,
    itemWidth: hit.item.width,
    background: { r: 1, g: 1, b: 1 },
    textColor: { r: 0, g: 0, b: 0 },
  };

  const before = await textOf(original);
  const { bytes, reports } = await buildEditedPdf(original, [rep]);
  const r = reports[0];
  console.log(
    `  method=${r.method}  font=${r.fontName}  widthErr=${r.fontWidthError?.toFixed(5) ?? '—'}pt  fit=${(r.fitScale * 100).toFixed(1)}%`,
  );
  r.notes.forEach((n) => console.log(`    · ${n}`));

  const after = await textOf(bytes);
  check('ข้อความใหม่อยู่ในไฟล์', after.includes(replace));
  check('ข้อความเดิมหายไปจาก text layer', !after.includes(find) === r.originalRemoved && r.originalRemoved);

  if (r.method === 'native') {
    // rewritten in place, so even the reading order is untouched
    const expected = before.replace(find, replace);
    check('ข้อความอื่นคงเดิมทุกตัว (เรียงลำดับเดิม)', expected === after, expected === after ? '' : diff(expected, after));
  } else if (r.method === 'erase') {
    // the redrawn run lands at the end of the content, and pdf.js re-derives the
    // implicit spaces around the hole, so compare content ignoring whitespace
    const a = squash(before.replace(find, ''));
    const b = squash(after.replace(replace, ''));
    check('ข้อความอื่นคงเดิม (ไม่นับช่องว่าง)', a === b, a === b ? '' : diff(a, b));
  } else {
    check('ข้อความเดิมทั้งหมดยังอยู่ครบ', after.includes(before));
  }

  // geometry: the replacement must land on the original baseline and not collide
  const outDoc = await load(bytes);
  const outPage = await extractPageText(outDoc, 1);
  const moved = findOnPage(outPage, replace)[0];
  if (moved) {
    const dx = Math.abs(moved.x - hit.x);
    const dy = Math.abs(moved.item.y - hit.item.y);
    check('ตำแหน่งตรงเดิม (< 0.01pt)', dx < 0.01 && dy < 0.01, `dx=${dx.toFixed(4)} dy=${dy.toFixed(4)}`);
    check(
      'ไม่ชนข้อความถัดไปในบรรทัด',
      moved.gapRight > 0,
      `เดิมเว้น ${fmtGap(hit.gapRight)} ใหม่เว้น ${fmtGap(moved.gapRight)}  (กว้าง ${hit.width.toFixed(2)} -> ${moved.width.toFixed(2)})`,
    );
  }

  fs.mkdirSync(OUT, { recursive: true });
  const tag = replace.replace(/[^0-9A-Za-z]+/g, '_');
  const outFile = path.join(OUT, path.basename(file).replace(/\.pdf$/i, `-edited-${tag}.pdf`));
  fs.writeFileSync(outFile, bytes);
  console.log(`  -> ${outFile}  (${original.length} -> ${bytes.length} bytes)`);
}

function squash(t: string): string {
  return t.replace(/\s+/g, '');
}

function fmtGap(g: number): string {
  return Number.isFinite(g) ? g.toFixed(2) + 'pt' : 'ไม่มีข้อความต่อท้าย';
}

function diff(a: string, b: string): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `ต่างที่ตำแหน่ง ${i}: ${JSON.stringify(a.slice(i - 12, i + 12))} vs ${JSON.stringify(b.slice(i - 12, i + 12))}`;
  }
  return '';
}

for (const name of JOB_FILES) {
  const file = path.join(JOB_DIR, name);
  if (!haveFixture(file, `งานจริง: ${name}`)) continue;
  // the actual change requested
  await runFile(file, '246/8', '135/7');
  // same length, different digits — proves it is not hard-coded to one string
  await runFile(file, '246/8', '135/9');
  // longer replacement — exercises the erase + redraw fallback
  await runFile(file, '246/8', '1234/56');
}

failures += await runWiderFixtures();
failures += await runPathChecks();
failures += await runMergeChecks();
failures += await runEditChecks();
failures += await runOrganizeChecks();
failures += await runSplitChecks();
failures += await runConvertChecks();
failures += await runCompressChecks();
failures += await runUnlockChecks();
failures += await runWorkerChecks();
failures += await runPwaChecks();

reportFixtureSkips();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
