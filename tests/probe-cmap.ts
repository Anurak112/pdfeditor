/**
 * Which characters does an embedded font actually carry?
 *
 * Subsetted fonts only ship the glyphs the document used, so "the font cannot
 * spell that" is a real, reachable state — this is how we find a character that
 * forces the editor off the native path and onto erase + redraw.
 *
 *   npx tsx tests/probe-cmap.ts <file.pdf>
 */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { collectEmbeddedFonts } from '../src/lib/pdf/embeddedFonts';

const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });

for (const font of collectEmbeddedFonts(doc.getPage(0))) {
  const chars = [...font.cmap.keys()].sort().join('');
  console.log(`${font.resourceName}  ${font.baseFont}  bytes=${font.bytesPerCode}  glyphs=${font.cmap.size}`);
  console.log(`  มีตัวอักษร: ${JSON.stringify(chars.slice(0, 120))}`);
  const missing = [...'ZQXJ%@#&*ก'].filter((c) => !font.cmap.has(c));
  console.log(`  ไม่มี: ${JSON.stringify(missing.join(''))}`);
}
