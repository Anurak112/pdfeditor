/**
 * The PDF standard security handler, read rather than written.
 *
 * Everything here exists to take protection off a document whose password the
 * person already has. There is deliberately no way to put protection on: the
 * same primitives would do it, and a tool that both locks and unlocks invites
 * exactly one question at the wrong moment.
 *
 * Four generations are covered, because a document does not get to choose when
 * it was made: RC4-40 and RC4-128 from the nineties, AES-128 from Acrobat 7,
 * and AES-256 from PDF 2.0. Anything else is named and refused rather than
 * guessed at — a wrong key produces a file that opens and is full of nonsense,
 * which is the worst failure this tool could have.
 */
import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFDocument } from 'pdf-lib';
import { aesDecryptStream, hash2B, md5, rc4, sha2, unwrapFileKey } from './crypto';

/** The padding string from the spec, appended to every short password. */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

export type CryptMethod = 'rc4' | 'aes128' | 'aes256' | 'identity';

export interface Encryption {
  v: number;
  r: number;
  /** File key length in bytes. */
  keyBytes: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array | null;
  ue: Uint8Array | null;
  permissions: number;
  encryptMetadata: boolean;
  streams: CryptMethod;
  strings: CryptMethod;
  /** First half of the file's /ID, part of the key for every revision below 5. */
  id: Uint8Array;
}

export interface Unsupported {
  unsupported: string;
}

function isRef(v: unknown): v is PDFRef {
  return v instanceof PDFRef;
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.asBytes();
  return new Uint8Array(0);
}

function numberOf(dict: PDFDict, key: string, fallback = 0): number {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

function methodOf(name: string): CryptMethod | null {
  if (name === '/V2') return 'rc4';
  if (name === '/AESV2') return 'aes128';
  if (name === '/AESV3') return 'aes256';
  if (name === '/None' || name === '/Identity') return 'identity';
  return null;
}

/**
 * Reads the /Encrypt dictionary, or says why it cannot.
 *
 * Returns null for a document that is not encrypted at all — which is a normal
 * answer, not a failure, and the caller has something friendlier to say about
 * it than an error would.
 */
export function readEncryption(doc: PDFDocument): Encryption | Unsupported | null {
  const ctx = doc.context;
  const encryptRef = ctx.trailerInfo.Encrypt;
  if (!encryptRef) return null;

  const dict = ctx.lookup(encryptRef);
  if (!(dict instanceof PDFDict)) return null;

  const filter = dict.get(PDFName.of('Filter'));
  if (!(filter instanceof PDFName) || filter.asString() !== '/Standard') {
    return {
      unsupported: `security handler ${filter instanceof PDFName ? filter.asString() : 'unknown'}`,
    };
  }

  const v = numberOf(dict, 'V', 0);
  const r = numberOf(dict, 'R', 0);
  if (v !== 1 && v !== 2 && v !== 4 && v !== 5) return { unsupported: `/V ${v}` };
  if (r < 2 || r > 6) return { unsupported: `/R ${r}` };

  const idArray = ctx.lookup(ctx.trailerInfo.ID);
  const id = idArray instanceof PDFArray && idArray.size() > 0 ? bytesOf(idArray.get(0)) : new Uint8Array(0);

  const base: Omit<Encryption, 'streams' | 'strings' | 'keyBytes'> = {
    v,
    r,
    o: bytesOf(dict.get(PDFName.of('O'))),
    u: bytesOf(dict.get(PDFName.of('U'))),
    oe: v === 5 ? bytesOf(dict.get(PDFName.of('OE'))) : null,
    ue: v === 5 ? bytesOf(dict.get(PDFName.of('UE'))) : null,
    permissions: numberOf(dict, 'P', 0),
    encryptMetadata: !(dict.get(PDFName.of('EncryptMetadata')) instanceof PDFBool)
      ? true
      : (dict.get(PDFName.of('EncryptMetadata')) as PDFBool).asBoolean(),
    id,
  };

  if (v === 1) return { ...base, keyBytes: 5, streams: 'rc4', strings: 'rc4' };
  if (v === 2) {
    const bits = numberOf(dict, 'Length', 40);
    return { ...base, keyBytes: Math.max(5, Math.min(16, bits >> 3)), streams: 'rc4', strings: 'rc4' };
  }

  // V4 and V5 route streams and strings through named crypt filters, which can
  // differ from each other — and either can be /Identity, meaning that class is
  // not encrypted at all.
  const filters = ctx.lookup(dict.get(PDFName.of('CF')));
  const pick = (which: 'StmF' | 'StrF'): CryptMethod | null => {
    const name = dict.get(PDFName.of(which));
    const asString = name instanceof PDFName ? name.asString() : '/Identity';
    if (asString === '/Identity') return 'identity';
    if (!(filters instanceof PDFDict)) return null;
    const entry = ctx.lookup(filters.get(PDFName.of(asString.slice(1))));
    if (!(entry instanceof PDFDict)) return null;
    const cfm = entry.get(PDFName.of('CFM'));
    return cfm instanceof PDFName ? methodOf(cfm.asString()) : null;
  };

  const streams = pick('StmF');
  const strings = pick('StrF');
  if (!streams || !strings) return { unsupported: 'an unrecognised crypt filter' };

  const keyBytes = v === 5 ? 32 : Math.max(5, Math.min(16, numberOf(dict, 'Length', 128) >> 3));
  return { ...base, keyBytes, streams, strings };
}

function padded(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const take = Math.min(32, password.length);
  out.set(password.subarray(0, take), 0);
  out.set(PAD.subarray(0, 32 - take), take);
  return out;
}

function int32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, n | 0, true);
  return out;
}

function xorAll(key: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) out[i] = key[i] ^ value;
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array, length: number): boolean {
  if (a.length < length || b.length < length) return false;
  let diff = 0;
  for (let i = 0; i < length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Algorithm 2: the file key, from an already-padded 32-byte password. */
export function fileKeyFromPadded(info: Encryption, paddedPassword: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [paddedPassword, info.o.subarray(0, 32), int32le(info.permissions), info.id];
  if (info.r >= 4 && !info.encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));

  let hash = md5(...parts);
  const n = info.r === 2 ? 5 : info.keyBytes;
  if (info.r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n));
  return hash.subarray(0, n);
}

/** Algorithm 4 and 5: what /U should look like if this key is right. */
export function expectedU(info: Encryption, key: Uint8Array): Uint8Array {
  if (info.r === 2) return rc4(key, PAD);
  let x = rc4(key, md5(PAD, info.id));
  for (let i = 1; i <= 19; i++) x = rc4(xorAll(key, i), x);
  return x;
}

/** Algorithm 7, in reverse: recover the padded user password from the owner's. */
export function userPasswordFromOwner(info: Encryption, ownerPassword: Uint8Array): Uint8Array {
  let hash = md5(padded(ownerPassword));
  if (info.r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, info.r === 2 ? 5 : info.keyBytes);

  if (info.r === 2) return rc4(key, info.o.subarray(0, 32));
  let x = info.o.subarray(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(xorAll(key, i), x);
  return x;
}

/**
 * How a password becomes bytes, which is not the same question in every revision.
 *
 * Below revision 5 the spec says the password is a sequence of bytes, and
 * readers produce them by throwing away everything above the low byte of each
 * character. Revision 6 changed to UTF-8. A Thai password therefore hashes to
 * two completely different keys depending on which era the file comes from —
 * found the hard way, by handing a fixture with a Thai password to pdf.js and
 * being told the password was wrong.
 *
 * Both are tried, because producers were not consistent either, and an extra
 * key derivation costs nothing next to being unable to open the file.
 */
function passwordBytes(password: string, revision: number): Uint8Array[] {
  if (revision >= 5) return [new TextEncoder().encode(password)];

  const latin1 = new Uint8Array(password.length);
  for (let i = 0; i < password.length; i++) latin1[i] = password.charCodeAt(i) & 0xff;

  const utf8 = new TextEncoder().encode(password);
  const same = utf8.length === latin1.length && utf8.every((b, i) => b === latin1[i]);
  return same ? [latin1] : [latin1, utf8];
}

export type Role = 'user' | 'owner';

export interface UnlockedKey {
  key: Uint8Array;
  /** Which password the given one turned out to be. */
  role: Role;
}

/**
 * Finds the file key, trying the password as the user's and then the owner's.
 *
 * Both are tried because the person unlocking rarely knows which they were
 * given, and an empty password is tried as the user's first — that is what a
 * document protected only against printing and copying looks like, and it opens
 * with no password at all.
 */
export async function unlock(info: Encryption, password: string): Promise<UnlockedKey | null> {
  if (info.v === 5) return unlockV5(info, new TextEncoder().encode(password));

  for (const bytes of passwordBytes(password, info.r)) {
    const asUser = fileKeyFromPadded(info, padded(bytes));
    if (sameBytes(expectedU(info, asUser), info.u, 16)) return { key: asUser, role: 'user' };

    const recovered = userPasswordFromOwner(info, bytes);
    const asOwner = fileKeyFromPadded(info, recovered);
    if (sameBytes(expectedU(info, asOwner), info.u, 16)) return { key: asOwner, role: 'owner' };
  }

  return null;
}

async function unlockV5(info: Encryption, password: Uint8Array): Promise<UnlockedKey | null> {
  const u48 = info.u.subarray(0, 48);
  const derive = info.r === 6
    ? (pw: Uint8Array, salt: Uint8Array, extra: Uint8Array) => hash2B(pw, salt, extra)
    : (pw: Uint8Array, salt: Uint8Array, extra: Uint8Array) => sha2(256, pw, salt, extra);

  const empty = new Uint8Array(0);

  const userHash = await derive(password, info.u.subarray(32, 40), empty);
  if (sameBytes(userHash, info.u, 32) && info.ue) {
    const intermediate = await derive(password, info.u.subarray(40, 48), empty);
    return { key: await unwrapFileKey(intermediate, info.ue), role: 'user' };
  }

  const ownerHash = await derive(password, info.o.subarray(32, 40), u48);
  if (sameBytes(ownerHash, info.o, 32) && info.oe) {
    const intermediate = await derive(password, info.o.subarray(40, 48), u48);
    return { key: await unwrapFileKey(intermediate, info.oe), role: 'owner' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// using the key
// ---------------------------------------------------------------------------

const SALT = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // "sAlT"

/**
 * Every object below revision 5 gets its own key, mixed from its object number.
 *
 * Which is why decryption has to happen with the object graph in hand rather
 * than over the raw bytes: the same file key produces a different stream cipher
 * for object 12 than for object 13.
 */
export function objectKey(info: Encryption, fileKey: Uint8Array, num: number, gen: number, aes: boolean): Uint8Array {
  if (info.v === 5) return fileKey;
  const extra = new Uint8Array(aes ? 9 : 5);
  extra[0] = num & 0xff;
  extra[1] = (num >> 8) & 0xff;
  extra[2] = (num >> 16) & 0xff;
  extra[3] = gen & 0xff;
  extra[4] = (gen >> 8) & 0xff;
  if (aes) extra.set(SALT, 5);
  return md5(fileKey, extra).subarray(0, Math.min(fileKey.length + 5, 16));
}

export class Decryptor {
  constructor(
    readonly info: Encryption,
    readonly fileKey: Uint8Array,
  ) {}

  private async apply(
    method: CryptMethod,
    data: Uint8Array,
    num: number,
    gen: number,
  ): Promise<Uint8Array | null> {
    if (method === 'identity' || data.length === 0) return data;
    const aes = method !== 'rc4';
    const key = objectKey(this.info, this.fileKey, num, gen, aes);
    if (!aes) return rc4(key, data);
    return aesDecryptStream(key, data);
  }

  stream(data: Uint8Array, num: number, gen: number): Promise<Uint8Array | null> {
    return this.apply(this.info.streams, data, num, gen);
  }

  string(data: Uint8Array, num: number, gen: number): Promise<Uint8Array | null> {
    return this.apply(this.info.strings, data, num, gen);
  }
}

// ---------------------------------------------------------------------------
// finding the strings
// ---------------------------------------------------------------------------

const HEX = '0123456789ABCDEF';

export function toHexString(bytes: Uint8Array): PDFHexString {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return PDFHexString.of(out);
}

/**
 * Every string reachable from one object, with the container that holds it.
 *
 * Returned as a list of writes rather than mutated in place because the walk
 * has to finish before anything changes: a decrypted string can contain the
 * bytes of a dictionary, and rewriting mid-walk is how a walker ends up
 * following its own output.
 */
export interface StringSlot {
  read(): Uint8Array;
  write(value: PDFHexString): void;
}

export function findStrings(ctx: PDFContext, root: unknown, seen = new Set<unknown>()): StringSlot[] {
  const slots: StringSlot[] = [];

  const visit = (node: unknown) => {
    if (node === undefined || node === null) return;
    if (isRef(node)) return; // followed from the top level, never through a reference
    if (seen.has(node)) return;

    if (node instanceof PDFDict) {
      seen.add(node);
      for (const [key, value] of node.entries()) {
        if (value instanceof PDFString || value instanceof PDFHexString) {
          const target = value;
          slots.push({ read: () => target.asBytes(), write: (v) => node.set(key, v) });
        } else visit(value);
      }
      return;
    }

    if (node instanceof PDFArray) {
      seen.add(node);
      for (let i = 0; i < node.size(); i++) {
        const value = node.get(i);
        if (value instanceof PDFString || value instanceof PDFHexString) {
          const target = value;
          slots.push({ read: () => target.asBytes(), write: (v) => node.set(i, v) });
        } else visit(value);
      }
      return;
    }
  };

  visit(root);
  return slots;
}
