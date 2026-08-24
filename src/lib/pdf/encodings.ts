/**
 * Character encoding for *simple* fonts (TrueType / Type1, one byte per glyph).
 *
 * A Type0 font says outright which glyph it means: the code IS the glyph id.
 * A simple font instead points at an encoding table — /WinAnsiEncoding and
 * friends — optionally patched by /Differences. To edit such text in place we
 * need both directions: code -> unicode (to read what is on the page) and
 * unicode -> code (to write the replacement with the same font).
 *
 * /ToUnicode, when the producer wrote one, is more reliable than any of this
 * and takes priority; these tables are the fallback for fonts without it —
 * typically the unembedded base-14 (Helvetica, Times) that jsPDF and Word emit.
 */
import { Encodings } from '@pdf-lib/standard-fonts';

/**
 * `unicodeMappings` is marked private in the typings but is plain data on the
 * object: { unicodeCodePoint: [code, glyphName] }. Reading it directly beats
 * probing `encodeUnicodeCodePoint` over the whole BMP to rebuild the same table.
 */
const WIN_ANSI_MAPPINGS = (Encodings.WinAnsi as unknown as {
  unicodeMappings: Record<string, [number, string]>;
}).unicodeMappings;

export type BaseEncodingName = 'WinAnsiEncoding' | 'MacRomanEncoding' | 'StandardEncoding' | 'PDFDocEncoding';

/** glyph name -> unicode string, e.g. "eacute" -> "é". Built once from WinAnsi. */
const glyphToUnicode = new Map<string, string>();
/** code -> unicode, per base encoding. */
const winAnsi = new Map<number, string>();

for (const [cpText, entry] of Object.entries(WIN_ANSI_MAPPINGS)) {
  const [code, name] = entry;
  const uni = String.fromCodePoint(Number(cpText));
  if (!glyphToUnicode.has(name)) glyphToUnicode.set(name, uni);
  if (!winAnsi.has(code)) winAnsi.set(code, uni);
}

// StandardEncoding differs from WinAnsi inside ASCII in exactly two places;
// above 127 the two diverge widely, but such text always ships a /ToUnicode.
const standard = new Map(winAnsi);
standard.set(0x27, '’'); // quoteright
standard.set(0x60, '‘'); // quoteleft
for (let code = 0xa0; code <= 0xff; code++) standard.delete(code);

// MacRomanEncoding agrees with ASCII below 128; the upper half needs its own
// table, which we do not carry — those codes stay unmapped rather than wrong.
const macRoman = new Map<number, string>();
for (const [code, uni] of winAnsi) if (code < 0x80) macRoman.set(code, uni);

const TABLES: Record<BaseEncodingName, Map<number, string>> = {
  WinAnsiEncoding: winAnsi,
  StandardEncoding: standard,
  MacRomanEncoding: macRoman,
  PDFDocEncoding: winAnsi,
};

export function baseEncodingTable(name: string | undefined): Map<number, string> {
  const clean = (name ?? '').replace(/^\//, '') as BaseEncodingName;
  return TABLES[clean] ?? winAnsi;
}

/**
 * Resolve a PostScript glyph name to the text it stands for.
 * Handles the Adobe glyph list (via WinAnsi), the uniXXXX / uXXXX escapes, and
 * the "letter + index" names some producers emit for subset fonts.
 */
export function unicodeForGlyphName(name: string): string | null {
  const direct = glyphToUnicode.get(name);
  if (direct) return direct;

  const uniHex = /^uni([0-9A-Fa-f]{4})(?:[0-9A-Fa-f]{4})*$/.exec(name);
  if (uniHex) return String.fromCharCode(parseInt(uniHex[1], 16));

  const uHex = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uHex) {
    const cp = parseInt(uHex[1], 16);
    if (cp <= 0x10ffff) return String.fromCodePoint(cp);
  }

  // "eacute.sc" / "one.oldstyle" — the part before the dot carries the meaning
  const dot = name.indexOf('.');
  if (dot > 0) return unicodeForGlyphName(name.slice(0, dot));

  return null;
}

/** The name the standard-14 metrics files use for a unicode character. */
export function glyphNameForUnicode(ch: string): string | null {
  const entry = WIN_ANSI_MAPPINGS[ch.codePointAt(0) ?? -1];
  return entry ? entry[1] : null;
}
