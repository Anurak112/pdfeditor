/**
 * What a file actually is, whatever its name claims.
 *
 * A file called .pdf that is really a JPEG is the single most common bad input,
 * and believing the label makes it fail much later and much more confusingly.
 * In the engine rather than the loader because Convert has to know which way it
 * is converting, and it only ever sees bytes.
 */

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function startsWith(bytes: Uint8Array, magic: number[], searchWindow = 0): boolean {
  for (let offset = 0; offset <= searchWindow; offset++) {
    let hit = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[offset + i] !== magic[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

export type SniffedKind = 'pdf' | 'jpeg' | 'png' | 'unknown';

/** What the bytes actually are, whatever the extension claims. */
export function sniff(bytes: Uint8Array): SniffedKind {
  // Some writers leave junk before the header; the PDF spec tolerates a small
  // offset and so do real readers, so we look a little way in.
  if (startsWith(bytes, PDF_MAGIC, 1024)) return 'pdf';
  if (startsWith(bytes, JPEG_MAGIC)) return 'jpeg';
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  return 'unknown';
}

export const MIME_FOR_KIND: Record<Exclude<SniffedKind, 'unknown'>, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
};


