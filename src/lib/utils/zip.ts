/**
 * A tiny ZIP writer — enough to hand back a folder of edited PDFs.
 *
 * Entries are stored, not deflated: a PDF's streams are already compressed, so
 * squeezing them again costs time and saves almost nothing. Names are written
 * as UTF-8 with the language-encoding flag set, which is what makes Thai
 * filenames survive the round trip into Windows Explorer.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** MS-DOS date/time, the only clock a ZIP header understands. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 31),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  /** Little-endian fixed-width numbers, the ZIP header's whole vocabulary. */
  u16(n: number) {
    this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff]));
  }

  u32(n: number) {
    this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Names must be unique inside the archive, or unzipping silently loses files. */
function uniqueNames(entries: ZipEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const taken = seen.get(entry.name) ?? 0;
    seen.set(entry.name, taken + 1);
    if (taken === 0) return entry.name;
    const dot = entry.name.lastIndexOf('.');
    return dot > 0
      ? `${entry.name.slice(0, dot)} (${taken + 1})${entry.name.slice(dot)}`
      : `${entry.name} (${taken + 1})`;
  });
}

export function createZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const stamp = dosStamp(now);
  const names = uniqueNames(entries);

  const body = new ByteWriter();
  const central = new ByteWriter();

  entries.forEach((entry, i) => {
    const name = encoder.encode(names[i]);
    const crc = crc32(entry.bytes);
    const offset = body.length;

    // local file header
    body.u32(0x04034b50);
    body.u16(20);         // version needed
    body.u16(0x0800);     // UTF-8 names
    body.u16(0);          // stored
    body.u16(stamp.time);
    body.u16(stamp.date);
    body.u32(crc);
    body.u32(entry.bytes.length);
    body.u32(entry.bytes.length);
    body.u16(name.length);
    body.u16(0);          // no extra field
    body.push(name);
    body.push(entry.bytes);

    // central directory entry
    central.u32(0x02014b50);
    central.u16(20);      // version made by
    central.u16(20);      // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(stamp.time);
    central.u16(stamp.date);
    central.u32(crc);
    central.u32(entry.bytes.length);
    central.u32(entry.bytes.length);
    central.u16(name.length);
    central.u16(0);       // extra
    central.u16(0);       // comment
    central.u16(0);       // disk number
    central.u16(0);       // internal attrs
    central.u32(0);       // external attrs
    central.u32(offset);
    central.push(name);
  });

  const out = new ByteWriter();
  const centralBytes = central.concat();
  out.push(body.concat());
  out.push(centralBytes);

  // end of central directory
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(centralBytes.length);
  out.u32(body.length);
  out.u16(0);

  return out.concat();
}

export function downloadZip(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
