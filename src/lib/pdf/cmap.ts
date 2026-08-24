/**
 * CMap helpers — parse a font's /ToUnicode stream and its /W width array.
 *
 * A Type0 / Identity-H font addresses glyphs by CID (2 bytes, == glyph id).
 * /ToUnicode maps CID -> unicode, which is how PDF text becomes copyable.
 * We invert it (unicode -> CID) so we can *write* text with the very font the
 * document already embeds — no new font, no visual mismatch.
 */

/** Decode a UTF-16BE hex run ("0E1A" / "D83DDE00") into a JS string. */
export function uniFromHex(hex: string): string {
  let out = '';
  for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  return out;
}

/**
 * Parse a ToUnicode CMap into unicode -> CID.
 * Handles both `beginbfchar` pairs and `beginbfrange` (base form and array form).
 * First mapping wins, so the lowest CID is preferred for duplicated glyphs.
 */
export function parseToUnicode(cmapText: string): Map<string, number> {
  const map = new Map<string, number>();

  for (const section of cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const uni = uniFromHex(m[2]);
      if (uni && !map.has(uni)) map.set(uni, parseInt(m[1], 16));
    }
  }

  for (const section of cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const body = section.replace(/beginbfrange|endbfrange/g, '');
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const m of body.matchAll(re)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[3] !== undefined) {
        // <lo> <hi> <baseUnicode>  — unicode increments with the CID
        const base = m[3];
        const head = base.slice(0, -4);
        const tail = parseInt(base.slice(-4), 16);
        for (let cid = lo; cid <= hi; cid++) {
          const uni = uniFromHex(head + (tail + cid - lo).toString(16).padStart(4, '0'));
          if (uni && !map.has(uni)) map.set(uni, cid);
        }
      } else {
        // <lo> <hi> [ <u1> <u2> ... ]
        const list = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => uniFromHex(x[1]));
        list.forEach((uni, i) => {
          if (uni && !map.has(uni)) map.set(uni, lo + i);
        });
      }
    }
  }
  return map;
}

/**
 * Parse a CIDFont /W array into CID -> width (1/1000 em).
 * Format: [ cFirst [w w w ...]  |  cFirst cLast w ]*
 */
export function parseWidths(entries: number[] | Array<number | number[]>): Map<number, number> {
  const widths = new Map<number, number>();
  const it = entries as Array<number | number[]>;
  let i = 0;
  while (i < it.length) {
    const first = it[i];
    if (Array.isArray(first)) { i++; continue; }
    const next = it[i + 1];
    if (Array.isArray(next)) {
      next.forEach((w, k) => widths.set(first + k, w));
      i += 2;
    } else if (typeof next === 'number' && typeof it[i + 2] === 'number') {
      const last = next;
      const w = it[i + 2] as number;
      if (last >= first && last - first <= 0xffff) for (let c = first; c <= last; c++) widths.set(c, w);
      i += 3;
    } else {
      i++;
    }
  }
  return widths;
}
