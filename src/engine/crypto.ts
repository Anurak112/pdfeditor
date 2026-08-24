/**
 * The primitives a PDF's standard security handler is built from.
 *
 * Two of them are here rather than borrowed because the platform does not have
 * them: WebCrypto has no MD5 and no RC4, and PDF encryption from 1996 onwards
 * is built on both. They are obsolete for protecting anything — which is the
 * point, since the job here is to take protection off a file whose password the
 * user already knows, not to add any.
 *
 * AES does come from WebCrypto, which exists in browsers, workers and Node
 * alike, so the one piece of real cryptography is not hand-rolled.
 */

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(2^32 * abs(sin(i + 1))), the table from RFC 1321. */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** Concatenated inputs in one digest, which is how every PDF algorithm uses it. */
export function md5(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;

  // Message, then 0x80, then zeros, then the bit length as 64-bit little endian.
  const padded = new Uint8Array(((total + 8) >> 6) * 64 + 64);
  let at = 0;
  for (const part of parts) {
    padded.set(part, at);
    at += part.length;
  }
  padded[total] = 0x80;
  const bits = total * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + words[g]) | 0, S[i])) | 0;
      a = tmp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(0, a0 >>> 0, true);
  new DataView(out.buffer).setUint32(4, b0 >>> 0, true);
  new DataView(out.buffer).setUint32(8, c0 >>> 0, true);
  new DataView(out.buffer).setUint32(12, d0 >>> 0, true);
  return out;
}

// ---------------------------------------------------------------------------
// RC4
// ---------------------------------------------------------------------------

/** Symmetric, so this both encrypts and decrypts — which is how the tests build fixtures. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }

  const out = new Uint8Array(data.length);
  let i = 0;
  let j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

// ---------------------------------------------------------------------------
// AES, through WebCrypto
// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('this host has no WebCrypto, so AES-encrypted files cannot be opened');
  return c.subtle;
}

async function aesKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return subtle().importKey('raw', copy(raw), { name: 'AES-CBC' }, false, [usage]);
}

/** WebCrypto refuses a view onto a larger buffer, and pdf-lib hands out plenty of those. */
function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

const ZERO_IV = new Uint8Array(16);

/**
 * CBC without padding, which WebCrypto does not offer.
 *
 * WebCrypto always strips a PKCS#7 block on decrypt, so decrypting N blocks
 * needs an N+1st that decrypts to valid padding. We hold the key, so we can
 * make one: encrypting sixteen 0x10 bytes with the last ciphertext block as the
 * IV produces exactly the block WebCrypto is looking for.
 */
async function decryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  const previous = data.length >= 16 ? data.subarray(data.length - 16) : iv;
  const filler = new Uint8Array(16).fill(16);
  const encrypter = await aesKey(key, 'encrypt');
  const block = new Uint8Array(
    await subtle().encrypt({ name: 'AES-CBC', iv: copy(previous) }, encrypter, copy(filler)),
  ).subarray(0, 16);

  const padded = new Uint8Array(data.length + 16);
  padded.set(data, 0);
  padded.set(block, data.length);

  const decrypter = await aesKey(key, 'decrypt');
  return new Uint8Array(
    await subtle().decrypt({ name: 'AES-CBC', iv: copy(iv) }, decrypter, copy(padded)),
  );
}

/** Likewise: WebCrypto appends a padding block on encrypt, and we drop it. */
export async function aesEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await aesKey(key, 'encrypt');
  const full = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: copy(iv) }, k, copy(data)));
  return full.subarray(0, data.length);
}

/**
 * A PDF AES stream: sixteen bytes of IV, then CBC ciphertext with PKCS#7.
 *
 * Returns null rather than throwing when the padding does not come out right,
 * because that is what a wrong password looks like from down here, and one
 * broken object should not lose the other four hundred.
 */
export async function aesDecryptStream(key: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  if (data.length <= 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16, data.length - ((data.length - 16) % 16));
  if (body.length === 0) return new Uint8Array(0);

  try {
    const k = await aesKey(key, 'decrypt');
    return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: copy(iv) }, k, copy(body)));
  } catch {
    return null;
  }
}

/** The same thing the other way round, so tests can build real encrypted files. */
export async function aesEncryptStream(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const k = await aesKey(key, 'encrypt');
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: copy(iv) }, k, copy(data)));
  const out = new Uint8Array(16 + body.length);
  out.set(iv, 0);
  out.set(body, 16);
  return out;
}

export async function sha2(bits: 256 | 384 | 512, ...parts: Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const part of parts) total += part.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return new Uint8Array(await subtle().digest(`SHA-${bits}`, copy(joined)));
}

/**
 * Algorithm 2.B — the hash that made AES-256 files slow to open on purpose.
 *
 * Sixty-four rounds minimum of hashing and AES, with the digest width chosen
 * each round by the ciphertext itself. Revision 5 skipped all of it and was
 * withdrawn for being too easy to attack; revision 6 is what PDF 2.0 uses.
 */
export async function hash2B(
  password: Uint8Array,
  salt: Uint8Array,
  userData: Uint8Array,
): Promise<Uint8Array> {
  let k = await sha2(256, password, salt, userData);

  for (let round = 0; ; round++) {
    const piece = new Uint8Array(password.length + k.length + userData.length);
    piece.set(password, 0);
    piece.set(k, password.length);
    piece.set(userData, password.length + k.length);

    const k1 = new Uint8Array(piece.length * 64);
    for (let i = 0; i < 64; i++) k1.set(piece, i * piece.length);

    const e = await aesEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);

    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const width = sum % 3 === 0 ? 256 : sum % 3 === 1 ? 384 : 512;
    k = await sha2(width, e);

    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }

  return k.subarray(0, 32);
}

/** AES-256 wraps the file key in one CBC block chain with a zero IV and no padding. */
export async function unwrapFileKey(intermediate: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array> {
  return decryptNoPad(intermediate, ZERO_IV, wrapped);
}

export async function wrapFileKey(intermediate: Uint8Array, fileKey: Uint8Array): Promise<Uint8Array> {
  return aesEncryptNoPad(intermediate, ZERO_IV, fileKey);
}
