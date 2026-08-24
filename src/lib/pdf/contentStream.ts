/**
 * Minimal PDF content-stream lexer + a surgical text rewriter.
 *
 * This is what makes "native" edits possible: instead of painting a white box
 * over the old number and drawing a new one on top (which leaves the original
 * string sitting in the text layer, still selectable and searchable), we find
 * the actual glyph codes in the page content stream and swap them in place.
 * The document then genuinely says 135/7.
 *
 * The walker keeps enough of a PDF interpreter — graphics state, text matrix,
 * spacing operators — to know *where on the page* every glyph lands. That is
 * what lets several occurrences of the same word be told apart: each one is
 * matched to the highlight the user picked by position, not by counting.
 *
 * Two shapes of text run are handled when rewriting:
 *
 *  · one glyph per string token, hopped along with `dx 0 Td` (what Stripe and
 *    LibreOffice emit). The run is rewritten into its first token and the hops
 *    are retuned, so the line keeps its exact rhythm.
 *  · a whole word or line inside one string token — `(238/1 Sukhumvit) Tj` —
 *    which is what jsPDF, ReportLab and most invoice generators emit.
 *
 * In both cases the replacement may be longer or shorter than the original:
 * a kerning number absorbs the difference so the pen ends exactly where it
 * would have, and nothing downstream shifts.
 *
 * Both Type0 (2-byte CID) and simple TrueType/Type1 (1-byte) fonts are
 * supported; `bytesPerCode` on the font decides how codes are read and written.
 */
import type { EmbeddedFont } from './embeddedFonts';

export type TokenType =
  | 'hex' | 'string' | 'number' | 'name'
  | 'array-open' | 'array-close' | 'dict-open' | 'dict-close'
  | 'operator';

export interface Token {
  type: TokenType;
  start: number;
  end: number;
  /** hex digits (uppercase) for `hex`; numeric value for `number`; name without the slash; operator text. */
  value: string | number;
}

const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

const OP_TJ = 'Tj';
const OP_TJ_ARRAY = 'TJ';
const OP_QUOTE = String.fromCharCode(39);       // '
const OP_DQUOTE = String.fromCharCode(34);      // "
const SHOW_OPS = new Set([OP_TJ, OP_TJ_ARRAY, OP_QUOTE, OP_DQUOTE]);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (WS.has(c)) { i++; continue; }

    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }

    if (c === '<') {
      if (src[i + 1] === '<') { tokens.push({ type: 'dict-open', start: i, end: i + 2, value: '<<' }); i += 2; continue; }
      const close = src.indexOf('>', i + 1);
      if (close < 0) break;
      const raw = src.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      tokens.push({ type: 'hex', start: i, end: close + 1, value: raw });
      i = close + 1;
      continue;
    }

    if (c === '>') {
      if (src[i + 1] === '>') { tokens.push({ type: 'dict-close', start: i, end: i + 2, value: '>>' }); i += 2; continue; }
      i++; continue;
    }

    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      }
      tokens.push({ type: 'string', start: i, end: j, value: src.slice(i + 1, j - 1) });
      i = j;
      continue;
    }

    if (c === '[') { tokens.push({ type: 'array-open', start: i, end: i + 1, value: '[' }); i++; continue; }
    if (c === ']') { tokens.push({ type: 'array-close', start: i, end: i + 1, value: ']' }); i++; continue; }

    if (c === '/') {
      let j = i + 1;
      while (j < n && !WS.has(src[j]) && !DELIM.has(src[j])) j++;
      tokens.push({ type: 'name', start: i, end: j, value: src.slice(i + 1, j) });
      i = j;
      continue;
    }

    if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.' || src[j] === '-' || src[j] === '+')) j++;
      const num = parseFloat(src.slice(i, j));
      if (!Number.isNaN(num)) tokens.push({ type: 'number', start: i, end: j, value: num });
      i = j;
      continue;
    }

    if (c === '{' || c === '}') { i++; continue; }

    let j = i;
    while (j < n && !WS.has(src[j]) && !DELIM.has(src[j])) j++;
    if (j === i) { i++; continue; }
    const op = src.slice(i, j);
    tokens.push({ type: 'operator', start: i, end: j, value: op });
    i = j;

    // inline image: the binary payload between ID and EI is not lexable
    if (op === 'ID') {
      const ei = src.indexOf('EI', i);
      i = ei < 0 ? n : ei + 2;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// matrices
// ---------------------------------------------------------------------------

/** PDF matrix [a b c d e f]. */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function translated(m: Matrix, tx: number, ty: number): Matrix {
  return multiply([1, 0, 0, 1, tx, ty], m);
}

// ---------------------------------------------------------------------------
// glyph index
// ---------------------------------------------------------------------------

export interface GlyphSlot {
  /** Font resource name in effect ("F4"). */
  fontRes: string;
  /** Font size from the Tf operator. */
  fontSize: number;
  /** Character code: a CID for Type0 fonts, a byte for simple ones. */
  code: number;
  /** Index into the token array of the hex/string token holding this glyph. */
  tokenIndex: number;
  /** Position of this glyph inside that token (0-based glyph index). */
  slotInToken: number;
  /** True when the token is a hex string. */
  isHex: boolean;
  /** How many bytes this glyph takes inside the token. */
  bytesPerCode: 1 | 2;
  /** Glyph origin in page user space (y up), or NaN when unknown. */
  x: number;
  y: number;
  /** Token index of the operator that last set the text position (Tm/Td/TD/T*). */
  placementToken: number;
  /** Which operator that was — only `Tm` places text outright. */
  placementOp: string;
}

/** What the walker needs to know about a font it meets in the stream. */
export interface FontMetricsLite {
  bytesPerCode: 1 | 2;
  /** Advance width of one code, in 1/1000 em. */
  widthOfCode(code: number): number;
}

/** Look up the font bound to a resource name, or null if we cannot read it. */
export type FontLookup = (fontRes: string) => FontMetricsLite | null;

interface TextState {
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  fontRes: string;
  fontSize: number;
}

function freshTextState(): TextState {
  return { charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, fontRes: '', fontSize: 0 };
}

/**
 * Walk the token stream and record every glyph drawn, in painting order,
 * together with where it lands on the page.
 *
 * Fonts the lookup does not know are read as 2-byte codes of unknown width:
 * we never rewrite those, and the only cost is that positions after them in
 * the same run are approximate.
 */
export function indexGlyphs(tokens: Token[], fontFor: FontLookup = () => null): GlyphSlot[] {
  const slots: GlyphSlot[] = [];

  let ctm: Matrix = IDENTITY;
  const ctmStack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let placementToken = -1;
  let placementOp = '';
  const ts = freshTextState();
  const numberAt = (i: number) => (tokens[i]?.type === 'number' ? (tokens[i].value as number) : 0);

  const drawToken = (tokenIndex: number) => {
    const tk = tokens[tokenIndex];
    if (!tk || (tk.type !== 'hex' && tk.type !== 'string')) return;
    const font = fontFor(ts.fontRes);
    const bytesPerCode = font?.bytesPerCode ?? 2;
    const codes = codesOfToken(tk, bytesPerCode);

    codes.forEach((code, slotInToken) => {
      const origin = multiply(tm, ctm);
      slots.push({
        fontRes: ts.fontRes,
        fontSize: ts.fontSize,
        code,
        tokenIndex,
        slotInToken,
        isHex: tk.type === 'hex',
        bytesPerCode,
        x: origin[4],
        y: origin[5],
        placementToken,
        placementOp,
      });

      const w0 = font ? font.widthOfCode(code) / 1000 : 0;
      const isSpace = bytesPerCode === 1 && code === 32;
      const advance = (w0 * ts.fontSize + ts.charSpacing + (isSpace ? ts.wordSpacing : 0)) * ts.hScale;
      tm = translated(tm, advance, 0);
    });
  };

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type !== 'operator') continue;
    const op = tk.value as string;

    switch (op) {
      case 'q':
        ctmStack.push(ctm);
        continue;
      case 'Q':
        ctm = ctmStack.pop() ?? IDENTITY;
        continue;
      case 'cm':
        ctm = multiply(
          [numberAt(i - 6), numberAt(i - 5), numberAt(i - 4), numberAt(i - 3), numberAt(i - 2), numberAt(i - 1)],
          ctm,
        );
        continue;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        placementToken = i;
        placementOp = 'BT';
        continue;
      case 'ET':
        continue;
      case 'Tf': {
        const nameTok = tokens[i - 2];
        if (nameTok?.type === 'name') ts.fontRes = nameTok.value as string;
        ts.fontSize = numberAt(i - 1);
        continue;
      }
      case 'Tc':
        ts.charSpacing = numberAt(i - 1);
        continue;
      case 'Tw':
        ts.wordSpacing = numberAt(i - 1);
        continue;
      case 'Tz':
        ts.hScale = numberAt(i - 1) / 100;
        continue;
      case 'TL':
        ts.leading = numberAt(i - 1);
        continue;
      case 'Ts':
        ts.rise = numberAt(i - 1);
        continue;
      case 'Td':
        tlm = translated(tlm, numberAt(i - 2), numberAt(i - 1));
        tm = tlm;
        placementToken = i;
        placementOp = 'Td';
        continue;
      case 'TD':
        ts.leading = -numberAt(i - 1);
        tlm = translated(tlm, numberAt(i - 2), numberAt(i - 1));
        tm = tlm;
        placementToken = i;
        placementOp = 'TD';
        continue;
      case 'Tm':
        tlm = [numberAt(i - 6), numberAt(i - 5), numberAt(i - 4), numberAt(i - 3), numberAt(i - 2), numberAt(i - 1)];
        tm = tlm;
        placementToken = i;
        placementOp = 'Tm';
        continue;
      case 'T*':
        tlm = translated(tlm, 0, -ts.leading);
        tm = tlm;
        placementToken = i;
        placementOp = 'T*';
        continue;
      case 'gs':
        continue;
      default:
        break;
    }

    if (!SHOW_OPS.has(op)) continue;

    if (op === OP_QUOTE || op === OP_DQUOTE) {
      if (op === OP_DQUOTE) {
        ts.wordSpacing = numberAt(i - 3);
        ts.charSpacing = numberAt(i - 2);
      }
      tlm = translated(tlm, 0, -ts.leading);
      tm = tlm;
      drawToken(i - 1);
      continue;
    }

    if (op === OP_TJ_ARRAY) {
      let depth = 0;
      let start = -1;
      for (let k = i - 1; k >= 0; k--) {
        if (tokens[k].type === 'array-close') depth++;
        else if (tokens[k].type === 'array-open') {
          if (depth === 0) { start = k; break; }
          depth--;
        }
      }
      if (start < 0) continue;
      for (let k = start + 1; k < i; k++) {
        const el = tokens[k];
        if (el.type === 'number') {
          tm = translated(tm, (-(el.value as number) / 1000) * ts.fontSize * ts.hScale, 0);
        } else {
          drawToken(k);
        }
      }
      continue;
    }

    drawToken(i - 1);
  }

  return slots;
}

function decodeLiteral(raw: string): number[] {
  const out: number[] = [];
  const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(raw.charCodeAt(i) & 0xff); continue; }
    const next = raw[++i];
    if (next === undefined) break;
    if (next in simple) { out.push(simple[next]); continue; }
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    if (next === '\n' || next === '\r') continue;
    out.push(next.charCodeAt(0) & 0xff);
  }
  return out;
}

/** Read one string token back into the character codes it draws. */
function codesOfToken(tk: Token, bytesPerCode: 1 | 2): number[] {
  const codes: number[] = [];
  const step = bytesPerCode * 2;
  if (tk.type === 'hex') {
    let hex = tk.value as string;
    if (hex.length % step !== 0) hex = hex.padEnd(hex.length + (step - (hex.length % step)), '0');
    for (let k = 0; k + step <= hex.length; k += step) codes.push(parseInt(hex.substr(k, step), 16));
  } else if (tk.type === 'string') {
    const bytes = decodeLiteral(tk.value as string);
    for (let k = 0; k + bytesPerCode <= bytes.length; k += bytesPerCode) {
      codes.push(bytesPerCode === 2 ? (bytes[k] << 8) | bytes[k + 1] : bytes[k]);
    }
  }
  return codes;
}

/**
 * Write character codes as a PDF hex string.
 * Hex is used even where the original was a literal `(...)` string: both are
 * the same object type to a viewer, and hex needs no escaping rules.
 */
function hexStringOf(codes: number[], bytesPerCode: 1 | 2): string {
  const digits = bytesPerCode * 2;
  let out = '<';
  for (const code of codes) out += code.toString(16).padStart(digits, '0').toUpperCase();
  return out + '>';
}

export interface NativeMatch {
  /** Index of the first glyph slot of the match. */
  slotStart: number;
  slotCount: number;
  fontRes: string;
  fontSize: number;
  /** Origin of the first glyph in page user space. */
  x: number;
  y: number;
}

/** Decode one font's glyph run back into text, then locate `needle` inside it. */
export function findInGlyphs(slots: GlyphSlot[], font: EmbeddedFont, needle: string): NativeMatch[] {
  if (!needle) return [];
  const mine: number[] = [];
  const posToLocal: number[] = [];
  let text = '';

  slots.forEach((s, idx) => {
    if (s.fontRes !== font.resourceName) return;
    const uni = font.reverse.get(s.code) ?? '';
    mine.push(idx);
    for (let k = 0; k < uni.length; k++) posToLocal.push(mine.length - 1);
    text += uni;
  });

  const out: NativeMatch[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    const firstLocal = posToLocal[at];
    const lastLocal = posToLocal[at + needle.length - 1];
    if (firstLocal === undefined || lastLocal === undefined) continue;
    // the match has to line up with whole glyphs on both ends
    const startsClean = at === 0 || posToLocal[at - 1] !== firstLocal;
    const endsClean = at + needle.length >= text.length || posToLocal[at + needle.length] !== lastLocal;
    if (!startsClean || !endsClean) continue;
    const slotStart = mine[firstLocal];
    out.push({
      slotStart,
      slotCount: lastLocal - firstLocal + 1,
      fontRes: slots[slotStart].fontRes,
      fontSize: slots[slotStart].fontSize,
      x: slots[slotStart].x,
      y: slots[slotStart].y,
    });
  }
  return out;
}

export interface Edit { start: number; end: number; text: string }

export interface NativePlan {
  edits: Edit[];
  /** Advance width of the original run, in text-space units at the Tf size. */
  originalAdvance: number;
  /** Advance width of the replacement, after any fit-scaling. */
  newAdvance: number;
  /** Below 1 when the replacement had to be tightened to fit the room available. */
  fitScale: number;
  /** True when hop distances or kerning were retuned so spacing stays exact. */
  spacingAdjusted: boolean;
  /** True when the run was rewritten as a TJ array inside one token. */
  rewroteToken: boolean;
  /** True when the character count changed. */
  lengthChanged: boolean;
}

/**
 * Build the byte edits that turn a matched glyph run into `replacement`.
 *
 * `maxAdvance` (text-space units at the Tf size) is the room before the next
 * thing on the line; exceeding it tightens tracking instead of colliding.
 */
export function planNativeEdit(
  tokens: Token[],
  slots: GlyphSlot[],
  match: NativeMatch,
  font: EmbeddedFont,
  replacement: string,
  maxAdvance?: number,
  options: { absorbDrift?: boolean } = {},
): NativePlan | { error: string } {
  const absorbDrift = options.absorbDrift !== false;
  const runSlots = slots.slice(match.slotStart, match.slotStart + match.slotCount);
  if (runSlots.length === 0) return { error: 'ไม่พบตัวอักษรที่จะแก้' };

  const newCodes: number[] = [];
  for (const ch of [...replacement]) {
    const code = font.cmap.get(ch);
    if (code === undefined) return { error: 'ฟอนต์เดิมไม่มีตัวอักษร "' + ch + '"' };
    newCodes.push(code);
  }

  const singleToken = runSlots.every((s) => s.tokenIndex === runSlots[0].tokenIndex);
  return singleToken
    ? planWithinToken(tokens, match, font, runSlots, newCodes, maxAdvance, absorbDrift)
    : planAcrossTokens(tokens, slots, match, font, runSlots, newCodes, maxAdvance, absorbDrift);
}

/** Shared geometry for both strategies. */
function measure(font: EmbeddedFont, size: number, runSlots: GlyphSlot[], newCodes: number[], maxAdvance?: number) {
  const widthOfCode = (code: number) => ((font.widths.get(code) ?? font.defaultWidth) / 1000) * size;
  const originalAdvance = runSlots.reduce((sum, s) => sum + widthOfCode(s.code), 0);
  const naturalAdvance = newCodes.reduce((sum, code) => sum + widthOfCode(code), 0);
  const fitScale =
    maxAdvance !== undefined && naturalAdvance > maxAdvance && naturalAdvance > 0 ? maxAdvance / naturalAdvance : 1;
  return { widthOfCode, originalAdvance, naturalAdvance, fitScale, effectiveAdvance: naturalAdvance * fitScale };
}

/**
 * Lay the replacement out as TJ array elements: the glyphs, plus kerning
 * numbers that squeeze them into the space available and then put the pen back
 * where the original run left it.
 */
function layoutParts(
  newCodes: number[],
  bytesPerCode: 1 | 2,
  size: number,
  geo: ReturnType<typeof measure>,
  targetAdvance: number,
  absorbDrift = true,
): string[] {
  // TJ numbers are thousandths of an em, positive = move left
  const toTj = (userUnits: number) => (-userUnits / (size || 1)) * 1000;
  const parts: string[] = [];

  if (geo.fitScale < 1 && newCodes.length > 1) {
    // tighten the gaps *between* glyphs — there are n-1 of them, and nothing
    // is added after the last one, so the ink ends up exactly `effectiveAdvance`
    const perGap = (geo.naturalAdvance - geo.effectiveAdvance) / (newCodes.length - 1);
    newCodes.forEach((code, i) => {
      parts.push(hexStringOf([code], bytesPerCode));
      if (i < newCodes.length - 1) parts.push(formatNumber(toTj(-perGap)));
    });
  } else {
    parts.push(hexStringOf(newCodes, bytesPerCode));
  }

  // absorbDrift puts the pen back where it was; without it the rest of the run
  // simply moves along, which is what "push the following text" wants
  const drift = geo.effectiveAdvance - targetAdvance;
  if (absorbDrift && Math.abs(drift) > 1e-6) parts.push(formatNumber(toTj(drift)));
  return parts;
}

/**
 * The whole run lives in one string token — rewrite that token as a TJ array.
 * Anything before or after the match inside the same token is carried across
 * unchanged, so only the matched glyphs move.
 */
function planWithinToken(
  tokens: Token[],
  match: NativeMatch,
  font: EmbeddedFont,
  runSlots: GlyphSlot[],
  newCodes: number[],
  maxAdvance?: number,
  absorbDrift = true,
): NativePlan | { error: string } {
  const tokenIndex = runSlots[0].tokenIndex;
  const tk = tokens[tokenIndex];
  const bytesPerCode = runSlots[0].bytesPerCode;
  if (bytesPerCode !== font.bytesPerCode) return { error: 'ขนาดรหัสตัวอักษรไม่ตรงกับฟอนต์' };

  const codes = codesOfToken(tk, bytesPerCode);
  const first = runSlots[0].slotInToken;
  const last = runSlots[runSlots.length - 1].slotInToken;
  if (last - first + 1 !== runSlots.length) return { error: 'ตัวอักษรที่ตรงกันไม่ติดกันในก้อนเดียว' };
  if (codes.length < last + 1) return { error: 'อ่านก้อนข้อความไม่ครบ' };

  const size = match.fontSize || 1;
  const geo = measure(font, size, runSlots, newCodes, maxAdvance);

  const prefix = codes.slice(0, first);
  const suffix = codes.slice(last + 1);
  const parts: string[] = [];
  if (prefix.length) parts.push(hexStringOf(prefix, bytesPerCode));
  parts.push(...layoutParts(newCodes, bytesPerCode, size, geo, geo.originalAdvance, absorbDrift));
  if (suffix.length) parts.push(hexStringOf(suffix, bytesPerCode));

  const edits: Edit[] = [];
  if (isInsideTjArray(tokens, tokenIndex)) {
    edits.push({ start: tk.start, end: tk.end, text: parts.join(' ') });
  } else {
    const showOp = tokens[tokenIndex + 1];
    if (showOp?.type !== 'operator' || showOp.value !== 'Tj') {
      return { error: 'รูปแบบการวาดข้อความยังไม่รองรับ (' + String(showOp?.value ?? '?') + ')' };
    }
    edits.push({ start: tk.start, end: showOp.end, text: '[' + parts.join(' ') + '] TJ' });
  }

  return {
    edits,
    originalAdvance: geo.originalAdvance,
    newAdvance: geo.effectiveAdvance,
    fitScale: geo.fitScale,
    spacingAdjusted: Math.abs(geo.effectiveAdvance - geo.originalAdvance) > 1e-6,
    rewroteToken: true,
    lengthChanged: newCodes.length !== runSlots.length,
  };
}

/** Is this string token an element of a `[ ... ] TJ` array? */
function isInsideTjArray(tokens: Token[], tokenIndex: number): boolean {
  for (let i = tokenIndex + 1; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type === 'array-close') return tokens[i + 1]?.type === 'operator' && tokens[i + 1].value === 'TJ';
    if (tk.type === 'operator') return false;
  }
  return false;
}

/**
 * The run is spread over several tokens, one glyph at a time, hopped along with
 * `dx 0 Td` — the shape Stripe and LibreOffice emit.
 *
 * Same character count: each code is swapped where it sits and every hop is
 * retuned to the new glyph's own width, which keeps the original rhythm.
 *
 * Different character count: the whole run is collapsed into its first token as
 * a TJ array, the other tokens are emptied, and the hops are zeroed except the
 * last one, which absorbs their total. The pen therefore leaves the run at the
 * exact position it used to, so the rest of the line never moves.
 */
function planAcrossTokens(
  tokens: Token[],
  slots: GlyphSlot[],
  match: NativeMatch,
  font: EmbeddedFont,
  runSlots: GlyphSlot[],
  newCodes: number[],
  maxAdvance?: number,
  absorbDrift = true,
): NativePlan | { error: string } {
  const bytesPerCode = runSlots[0].bytesPerCode;
  if (runSlots.some((s) => s.bytesPerCode !== bytesPerCode)) return { error: 'ขนาดรหัสตัวอักษรไม่สม่ำเสมอ' };

  const size = match.fontSize || 1;
  const geo = measure(font, size, runSlots, newCodes, maxAdvance);
  const sameLength = newCodes.length === runSlots.length;

  const edits: Edit[] = [];
  let spacingAdjusted = false;

  if (sameLength) {
    // 1. swap the codes inside each token
    const byToken = new Map<number, Map<number, number>>();
    runSlots.forEach((s, i) => {
      if (!byToken.has(s.tokenIndex)) byToken.set(s.tokenIndex, new Map());
      byToken.get(s.tokenIndex)!.set(s.slotInToken, newCodes[i]);
    });
    for (const [tokenIndex, swaps] of byToken) {
      const tk = tokens[tokenIndex];
      const codes = codesOfToken(tk, bytesPerCode);
      for (const [slot, code] of swaps) codes[slot] = code;
      edits.push({ start: tk.start, end: tk.end, text: hexStringOf(codes, bytesPerCode) });
    }

    // 2. retune each `dx 0 Td` hop.
    //    The hop measures the whole token it follows, so it moves by how much
    //    THAT token's glyphs changed — not by the width of its last glyph,
    //    which is only the same thing when a token holds a single glyph.
    let deltaInToken = 0;
    for (let i = 0; i < runSlots.length; i++) {
      const here = runSlots[i];
      deltaInToken += geo.widthOfCode(newCodes[i]) - geo.widthOfCode(here.code);
      const next = slots[match.slotStart + i + 1];
      if (!next || next.tokenIndex === here.tokenIndex) continue;

      const td = findTdBetween(tokens, here.tokenIndex, next.tokenIndex);
      if (td) {
        const hop = ((td.value as number) + deltaInToken) * geo.fitScale;
        edits.push({ start: td.start, end: td.end, text: formatNumber(hop) });
        spacingAdjusted = true;
      }
      deltaInToken = 0;
    }

    edits.sort((a, b) => a.start - b.start);
    return {
      edits,
      originalAdvance: geo.originalAdvance,
      newAdvance: geo.effectiveAdvance,
      fitScale: geo.fitScale,
      spacingAdjusted,
      rewroteToken: false,
      lengthChanged: false,
    };
  }

  // --- collapse the run into its first token ---------------------------------
  const tokenIndexes = [...new Set(runSlots.map((s) => s.tokenIndex))];
  for (const tokenIndex of tokenIndexes) {
    const inThisToken = runSlots.filter((s) => s.tokenIndex === tokenIndex).length;
    const totalInToken = slots.filter((s) => s.tokenIndex === tokenIndex).length;
    if (inThisToken !== totalInToken) return { error: 'ข้อความอยู่ปนกับตัวอื่นในก้อนเดียวกัน' };
    const showOp = tokens[tokenIndex + 1];
    const inArray = isInsideTjArray(tokens, tokenIndex);
    if (!inArray && (showOp?.type !== 'operator' || showOp.value !== 'Tj')) {
      return { error: 'รูปแบบการวาดข้อความยังไม่รองรับ' };
    }
  }

  const separators: Separator[] = [];
  for (let i = 0; i < tokenIndexes.length - 1; i++) {
    separators.push(separatorBetween(tokens, tokenIndexes[i], tokenIndexes[i + 1]));
  }
  if (separators.some((sep) => sep.kind === 'unknown')) {
    return { error: 'ตัวอักษรถูกวางด้วยวิธีที่ยังรื้อไม่ได้' };
  }

  const hops = separators.filter((sep): sep is { kind: 'relative'; dx: Token } => sep.kind === 'relative').map((sep) => sep.dx);
  const positioned = separators.some((sep) => sep.kind === 'absolute');
  if (hops.length > 0 && positioned) {
    return { error: 'ตัวอักษรถูกวางปนกันสองวิธี — ยังรื้อไม่ได้' };
  }

  const hopTotal = hops.reduce((sum, td) => sum + (td.value as number), 0);
  const lastGlyphWidth = geo.widthOfCode(runSlots[runSlots.length - 1].code);

  // where the pen has to end up. With `dx 0 Td` hops that is the hops plus the
  // last glyph's own advance; otherwise it is simply the width of what was there
  const targetAdvance = hops.length > 0 ? hopTotal + lastGlyphWidth : geo.originalAdvance;
  const firstToken = tokens[tokenIndexes[0]];
  const parts = layoutParts(newCodes, bytesPerCode, size, geo, targetAdvance, absorbDrift);

  const firstShowOp = tokens[tokenIndexes[0] + 1];
  if (isInsideTjArray(tokens, tokenIndexes[0])) {
    edits.push({ start: firstToken.start, end: firstToken.end, text: parts.join(' ') });
  } else {
    edits.push({ start: firstToken.start, end: firstShowOp.end, text: '[' + parts.join(' ') + '] TJ' });
  }

  // empty the rest of the run's tokens, keeping byte positions valid
  for (const tokenIndex of tokenIndexes.slice(1)) {
    const tk = tokens[tokenIndex];
    edits.push({ start: tk.start, end: tk.end, text: '<>' });
  }

  // zero every hop but the last, which now carries the whole distance
  hops.forEach((td, i) => {
    const isLast = i === hops.length - 1;
    edits.push({ start: td.start, end: td.end, text: formatNumber(isLast ? hopTotal : 0) });
  });
  spacingAdjusted = true;

  edits.sort((a, b) => a.start - b.start);
  return {
    edits,
    originalAdvance: geo.originalAdvance,
    newAdvance: geo.effectiveAdvance,
    fitScale: geo.fitScale,
    spacingAdjusted,
    rewroteToken: true,
    lengthChanged: true,
  };
}

/**
 * How the writer got from one string token to the next.
 *
 *  · `relative` — a `dx 0 Td` hop we can retune
 *  · `absolute` — a `Tm` / `BT` / `T*` that sets the position outright, so the
 *    following token does not care what the run before it was worth
 *  · `none`     — nothing at all: the pen simply advanced by the glyph widths
 *  · `unknown`  — something we do not model; callers must refuse to rewrite
 */
type Separator =
  | { kind: 'relative'; dx: Token }
  | { kind: 'absolute' }
  | { kind: 'none' }
  | { kind: 'unknown' };

function separatorBetween(tokens: Token[], fromToken: number, toToken: number): Separator {
  for (let i = fromToken + 1; i < toToken; i++) {
    const tk = tokens[i];
    if (tk.type !== 'operator') continue;
    const op = tk.value as string;
    if (op === 'Tm' || op === 'BT' || op === 'T*') return { kind: 'absolute' };
    if (op === 'Td' || op === 'TD') {
      const dx = tokens[i - 2];
      const dy = tokens[i - 1];
      if (dx?.type === 'number' && dy?.type === 'number' && dy.value === 0) return { kind: 'relative', dx };
      return { kind: 'unknown' };
    }
    if (op === 'Tj' || op === 'TJ' || op === 'ET' || op === 'Tf' || op === 'q' || op === 'Q' || op === 'cm') continue;
    if (op === 'Tc' || op === 'Tw' || op === 'Tz' || op === 'TL' || op === 'Ts' || op === 'gs') continue;
    if (op === 'rg' || op === 'g' || op === 'k' || op === 'cs' || op === 'scn' || op === 'sc') continue;
    return { kind: 'unknown' };
  }
  return { kind: 'none' };
}

/** Find the `dx 0 Td` hop between two string tokens, if that is how the writer moved. */
function findTdBetween(tokens: Token[], fromToken: number, toToken: number): Token | null {
  for (let i = fromToken + 1; i < toToken; i++) {
    const tk = tokens[i];
    if (tk.type !== 'operator') continue;
    const op = tk.value as string;
    if (op === 'Tm' || op === 'T*' || op === 'BT') return null; // absolute move — nothing to retune
    if (op !== 'Td' && op !== 'TD') continue;
    const dx = tokens[i - 2];
    const dy = tokens[i - 1];
    if (dx?.type === 'number' && dy?.type === 'number' && dy.value === 0) return dx;
    return null;
  }
  return null;
}

function formatNumber(n: number): string {
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

/**
 * Plan the removal of a matched glyph run from the stream.
 *
 * Used by the overlay path so the replaced text is genuinely gone — not merely
 * hidden under a patch where a copy-paste would still reveal it.
 *
 * Only accepted when it is provably safe: every affected string token is
 * consumed whole, drawn by a plain `Tj`, and followed by an explicit move
 * (`Td` / `Tm` / `T*` / a new text object). Under those conditions the glyphs
 * that follow are positioned absolutely, so deleting ink shifts nothing.
 */
export function planEraseGlyphs(
  tokens: Token[],
  slots: GlyphSlot[],
  match: NativeMatch,
): { edits: Edit[] } | { error: string } {
  const runSlots = slots.slice(match.slotStart, match.slotStart + match.slotCount);

  const perToken = new Map<number, number>();
  for (const s of runSlots) perToken.set(s.tokenIndex, (perToken.get(s.tokenIndex) ?? 0) + 1);

  const edits: Edit[] = [];
  for (const [tokenIndex, hitCount] of perToken) {
    const total = slots.filter((s) => s.tokenIndex === tokenIndex).length;
    if (total !== hitCount) return { error: 'ข้อความอยู่ปนกับตัวอื่นในก้อนเดียวกัน' };

    const showOp = tokens[tokenIndex + 1];
    if (showOp?.type !== 'operator' || showOp.value !== 'Tj') return { error: 'รูปแบบการวาดข้อความยังไม่รองรับการลบ' };

    // whatever comes next must be placed by an explicit move, not by advance width
    const nextGlyph = slots.find((s) => s.tokenIndex > tokenIndex);
    if (nextGlyph && !hasExplicitMoveBetween(tokens, tokenIndex, nextGlyph.tokenIndex)) {
      return { error: 'ลบแล้วข้อความถัดไปจะเลื่อน' };
    }

    // blank out "<hex> Tj" — the Td chain around it keeps every position intact
    edits.push({ start: tokens[tokenIndex].start, end: showOp.end, text: ' '.repeat(showOp.end - tokens[tokenIndex].start) });
  }

  edits.sort((a, b) => a.start - b.start);
  return { edits };
}

function hasExplicitMoveBetween(tokens: Token[], fromToken: number, toToken: number): boolean {
  for (let i = fromToken + 1; i < toToken; i++) {
    const tk = tokens[i];
    if (tk.type !== 'operator') continue;
    const op = tk.value as string;
    if (op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*' || op === 'BT' || op === 'ET') return true;
  }
  return false;
}

export interface ShiftPlan {
  /** Edits that move `Tm`-placed text right. */
  edits: Edit[];
  /**
   * Glyphs that will move on their own because they trail the edit inside the
   * same text object — the pen carries them once the plan stops absorbing the
   * width difference. Nothing to edit for these, but they DO move.
   */
  trailing: number;
}

/**
 * Work out what moves right when a replacement grows by `delta`.
 *
 * Text after the edit on the same line moves in one of two ways:
 *  · it trails the edit in the same text object → the pen already carries it
 *  · it is placed by its own `Tm` → that `Tm` has to be edited
 *
 * Text to the left, on other lines, or placed by any other means is left where
 * it is. When neither kind exists, nothing moves at all — and the caller needs
 * to know that, rather than reporting a push that did not happen.
 */
export function planShiftAfter(
  tokens: Token[],
  slots: GlyphSlot[],
  match: NativeMatch,
  delta: number,
  fromX: number,
): ShiftPlan {
  const empty: ShiftPlan = { edits: [], trailing: 0 };
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) return empty;
  if (!Number.isFinite(match.y) || !Number.isFinite(fromX)) return empty;

  const tolerance = Math.max(1, (match.fontSize || 10) * 0.35);
  const runEnd = match.slotStart + match.slotCount;
  // text sharing the edit's own `Tm` is drawn after it inside the same text
  // object, so it already follows the pen — moving that Tm would shift the
  // edited word too, and shift its neighbours twice
  const ownPlacement = slots[match.slotStart]?.placementToken ?? -1;
  const targets = new Set<number>();
  let trailing = 0;

  for (let i = runEnd; i < slots.length; i++) {
    const slot = slots[i];
    if (Math.abs(slot.y - match.y) > tolerance) continue;
    if (slot.x < fromX - 0.01) continue;
    if (slot.placementToken === ownPlacement) {
      trailing++;
      continue;
    }
    if (slot.placementOp !== 'Tm' || slot.placementToken < 0) continue;
    targets.add(slot.placementToken);
  }

  const edits: Edit[] = [];
  for (const tokenIndex of targets) {
    // Tm takes six numbers; the fifth is the horizontal translation
    const tx = tokens[tokenIndex - 2];
    if (tx?.type !== 'number') continue;
    edits.push({ start: tx.start, end: tx.end, text: formatNumber((tx.value as number) + delta) });
  }
  edits.sort((a, b) => a.start - b.start);
  return { edits, trailing };
}

/** Apply non-overlapping edits to the source string, back to front. */
export function applyEdits(src: string, edits: Edit[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
