/** One-off helper: write the corrected copies of the two job documents. */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { extractPageText, findOnPage } from '../src/lib/pdf/textExtract';
import { buildEditedPdf, type Replacement } from '../src/lib/pdf/exporter';
import { docText, fixture, jobFolder } from './fixtures';

const JOB_DIR = jobFolder();
const OUT = path.join(import.meta.dirname, '..', 'output');
const FIND = docText('jobInvoice', 'address');
const REPLACE = '135/7';
if (!FIND) throw new Error('ตั้งค่า text.jobInvoice.address ใน tests/fixtures.local.json ก่อน');

fs.mkdirSync(OUT, { recursive: true });
for (const key of ['jobInvoice', 'jobReceipt'] as const) {
  const src = fixture(key);
  const name = path.basename(src);
  const bytes = new Uint8Array(fs.readFileSync(src));
  const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise) as never;
  const pageText = await extractPageText(doc, 1);
  const hit = findOnPage(pageText, FIND)[0];
  if (!hit) { console.log('SKIP ' + name + ' — ไม่พบ ' + FIND); continue; }
  const rep: Replacement = {
    id: 'job', page: 1, find: FIND, replace: REPLACE, ordinal: hit.ordinal,
    x: hit.x, y: hit.item.y, width: hit.width, fontSize: hit.item.fontSize,
    ascent: hit.item.ascent, descent: hit.item.descent, gapRight: hit.gapRight,
    itemText: hit.item.text, itemWidth: hit.item.width,
    background: { r: 1, g: 1, b: 1 }, textColor: { r: 0, g: 0, b: 0 },
  };
  const { bytes: out, reports } = await buildEditedPdf(bytes, [rep]);
  const dst = path.join(OUT, name.replace(/\.pdf$/i, '-edited.pdf'));
  fs.writeFileSync(dst, out);
  const check = (await extractPageText((await pdfjsLib.getDocument({ data: new Uint8Array(out) }).promise) as never, 1))
    .items.map((i) => i.text).join('');
  console.log(`${name}  method=${reports[0].method}  ${FIND}->${REPLACE}  ` +
    `newPresent=${check.includes(REPLACE)} oldGone=${!check.includes(FIND)}  -> ${dst}`);
}
