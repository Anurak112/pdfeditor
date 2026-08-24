/**
 * Diagnostic: what kind of fonts does a PDF use, and can we edit its text in place?
 *
 * Run: npx tsx tests/probe-fonts.ts <file.pdf> [more.pdf ...]
 *
 * Prints, per page, every font resource with its subtype/encoding and whether a
 * ToUnicode map exists — the three things that decide native vs overlay — plus a
 * sample of how the text is actually drawn (hex vs literal string).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream,
} from 'pdf-lib';

const latin1 = new TextDecoder('latin1');

/** pdf-lib's typed lookup throws when the key is absent — this just returns undefined. */
function maybe<T>(dict: PDFDict | undefined, key: string, type: any): T | undefined {
  if (!dict) return undefined;
  try {
    return dict.lookup(PDFName.of(key), type) as T;
  } catch {
    return undefined;
  }
}

function streamText(page: any): string {
  const ctx = page.doc.context;
  const entry = page.node.get(PDFName.of('Contents'));
  const refs: PDFRef[] = [];
  const collect = (arr: PDFArray) => {
    for (let i = 0; i < arr.size(); i++) { const it = arr.get(i); if (it instanceof PDFRef) refs.push(it); }
  };
  if (entry instanceof PDFRef) {
    const r = ctx.lookup(entry);
    if (r instanceof PDFArray) collect(r); else refs.push(entry);
  } else if (entry instanceof PDFArray) collect(entry);

  let out = '';
  for (const ref of refs) {
    const s = ctx.lookup(ref);
    if (s instanceof PDFRawStream) out += latin1.decode(decodePDFRawStream(s).decode());
  }
  return out;
}

async function probe(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  console.log('\n=== ' + basename(path) + '  (' + doc.getPageCount() + ' pages) ===');

  for (let p = 0; p < Math.min(doc.getPageCount(), 3); p++) {
    const page = doc.getPage(p);
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    console.log('  -- page ' + (p + 1) + ' --');
    if (!fonts) { console.log('     (no font resources)'); continue; }

    for (const [key] of fonts.entries()) {
      let fd: PDFDict | undefined;
      try { fd = fonts.lookup(key, PDFDict); } catch { fd = undefined; }
      if (!fd) continue;
      const sub = fd.get(PDFName.of('Subtype'))?.toString() ?? '?';
      const base = fd.get(PDFName.of('BaseFont'))?.toString() ?? '?';
      const enc = fd.get(PDFName.of('Encoding'));
      let encDesc = enc?.toString() ?? '(none)';
      if (enc && !(enc instanceof PDFName)) {
        const encDict = maybe<PDFDict>(fd, 'Encoding', PDFDict);
        const baseEnc = encDict?.get(PDFName.of('BaseEncoding'))?.toString() ?? '(implicit)';
        const diffs = maybe<PDFArray>(encDict, 'Differences', PDFArray);
        encDesc = 'dict base=' + baseEnc + ' differences=' + (diffs ? diffs.size() + ' entries' : 'no');
      }
      const hasToUni = !!fd.get(PDFName.of('ToUnicode'));
      const first = fd.get(PDFName.of('FirstChar'));
      const widths = maybe<PDFArray>(fd, 'Widths', PDFArray);
      const descendant = maybe<PDFArray>(fd, 'DescendantFonts', PDFArray);
      let descendantDict: PDFDict | undefined;
      try { descendantDict = descendant?.lookup(0, PDFDict); } catch { descendantDict = undefined; }
      const desc = maybe<PDFDict>(fd, 'FontDescriptor', PDFDict) ?? maybe<PDFDict>(descendantDict, 'FontDescriptor', PDFDict);
      const embedded = desc ? ['FontFile', 'FontFile2', 'FontFile3'].filter((f) => desc.get(PDFName.of(f))).join(',') || 'NOT EMBEDDED' : 'no descriptor';

      console.log(
        '     ' + key.asString().padEnd(6) +
        ' ' + sub.replace('/', '').padEnd(9) +
        ' ' + base.replace('/', '').padEnd(30) +
        ' enc=' + encDesc.padEnd(22) +
        ' ToUnicode=' + (hasToUni ? 'yes' : 'NO ') +
        ' Widths=' + (widths ? widths.size() + '@' + (first instanceof PDFNumber ? first.asNumber() : '?') : '-') +
        ' file=' + embedded,
      );
    }

    const text = streamText(page);
    const hexShows = (text.match(/<[0-9a-fA-F\s]+>\s*Tj/g) ?? []).length;
    const litShows = (text.match(/\)\s*Tj/g) ?? []).length;
    const tjArrays = (text.match(/\]\s*TJ/g) ?? []).length;
    console.log('     draws: hex Tj=' + hexShows + '  literal Tj=' + litShows + '  TJ arrays=' + tjArrays + '  streamLen=' + text.length);
    const sample = text.match(/BT[\s\S]{0,260}/)?.[0] ?? '';
    if (sample) console.log('     sample: ' + JSON.stringify(sample.slice(0, 240)));
  }
}

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: tsx tests/probe-fonts.ts <file.pdf> ...'); process.exit(1); }
for (const f of files) await probe(f).catch((e) => console.log('  !! ' + basename(f) + ': ' + e.message));
