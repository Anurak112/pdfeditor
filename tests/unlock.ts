/**
 * Unlock, judged by somebody else.
 *
 * A decryptor tested against its own encryptor proves only that two halves of
 * one misunderstanding agree. So every fixture here is handed to pdf.js first,
 * with the password, and has to open and read back correctly there before the
 * unlocker is allowed near it. pdf.js has an independent, twenty-year-old
 * implementation of this handler; if it accepts the file, the file is really
 * encrypted, and the unlocking is then a real test rather than a mirror.
 *
 * There is a real one too — a Thai company registration certificate with an
 * empty user password, the "you may read but not print" protection that most
 * locked documents in the wild actually carry.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream } from 'pdf-lib';
import { aesEncryptNoPad, aesEncryptStream, hash2B, md5, rc4 } from '../src/engine/crypto';
import {
  Decryptor,
  expectedU,
  fileKeyFromPadded,
  findStrings,
  objectKey,
  readEncryption,
  toHexString,
} from '../src/engine/decrypt';
import type { Encryption } from '../src/engine/decrypt';
import { UNLOCK_DEFAULTS, unlockOperation } from '../src/engine/operations/unlock';
import { createJob, runJob } from '../src/engine/job';
import type { JobFile, OperationContext } from '../src/engine/types';
import type { AppError } from '../src/engine/errors';

import { fixture } from './fixtures';
const OUT = path.join(import.meta.dirname, 'out');

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * The low byte of each character, which is how a reader turns a password into
 * bytes for anything below revision 5. Producers of that era did the same, so
 * a fixture that uses UTF-8 there is a fixture no real reader would open.
 */
const latin1 = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

type Encoding = 'latin1' | 'utf8';

function pad32(password: string, encoding: Encoding): Uint8Array {
  const bytes = encoding === 'utf8' ? utf8(password) : latin1(password);
  const out = new Uint8Array(32);
  const take = Math.min(32, bytes.length);
  out.set(bytes.subarray(0, take), 0);
  out.set(PAD.subarray(0, 32 - take), take);
  return out;
}

function xorAll(key: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) out[i] = key[i] ^ value;
  return out;
}

/** Deterministic "randomness", so a failing fixture can be reproduced exactly. */
function pseudoRandom(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// building genuinely encrypted files
// ---------------------------------------------------------------------------

interface Variant {
  label: string;
  v: 1 | 2 | 4 | 5;
  r: 2 | 3 | 4 | 6;
  keyBytes: number;
  cipher: 'rc4' | 'aes128' | 'aes256';
}

export const VARIANTS: Variant[] = [
  { label: 'RC4 40 บิต (R2 · ยุคแรกสุด)', v: 1, r: 2, keyBytes: 5, cipher: 'rc4' },
  { label: 'RC4 128 บิต (R3)', v: 2, r: 3, keyBytes: 16, cipher: 'rc4' },
  { label: 'AES-128 (R4 · Acrobat 7)', v: 4, r: 4, keyBytes: 16, cipher: 'aes128' },
  { label: 'AES-256 (R6 · PDF 2.0)', v: 5, r: 6, keyBytes: 32, cipher: 'aes256' },
];

/** Algorithm 3: /O, which hides the user password behind the owner's. */
function computeO(
  variant: Variant,
  userPassword: string,
  ownerPassword: string,
  encoding: Encoding,
): Uint8Array {
  let hash = md5(pad32(ownerPassword || userPassword, encoding));
  if (variant.r >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const key = hash.subarray(0, variant.r === 2 ? 5 : variant.keyBytes);

  let x = pad32(userPassword, encoding);
  if (variant.r === 2) return rc4(key, x);
  x = rc4(key, x);
  for (let i = 1; i <= 19; i++) x = rc4(xorAll(key, i), x);
  return x;
}

interface Locked {
  bytes: Uint8Array;
  userPassword: string;
  ownerPassword: string;
}

/**
 * Locks a document the way a real producer would.
 *
 * Deliberately in the test rather than the engine. The primitives are the same
 * either way, and the moment locking ships as a feature the tool stops being
 * "take the password off your own file" and becomes something else.
 */
export async function lock(
  plain: Uint8Array,
  variant: Variant,
  userPassword: string,
  ownerPassword: string,
  permissions = -3904,
  encoding: Encoding = 'latin1',
): Promise<Locked> {
  const doc = await PDFDocument.load(plain, { ignoreEncryption: true });
  const ctx = doc.context;

  const id = pseudoRandom(variant.r * 7919 + 13, 16);
  ctx.trailerInfo.ID = ctx.obj([toHexString(id), toHexString(id)]);

  // pdf-lib's obj() takes a literal tree; typed loosely here because the
  // entries differ by revision and a union of five shapes reads worse than this.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const encryptEntries: Record<string, any> = {
    Filter: 'Standard',
    V: variant.v,
    R: variant.r,
    P: permissions,
  };
  if (variant.v !== 1) encryptEntries.Length = variant.keyBytes * 8;

  let fileKey: Uint8Array;
  let info: Encryption;

  if (variant.v === 5) {
    fileKey = pseudoRandom(0x5eed, 32);
    const empty = new Uint8Array(0);

    const uvs = pseudoRandom(11, 8);
    const uks = pseudoRandom(22, 8);
    const uHash = await hash2B(utf8(userPassword), uvs, empty);
    const u = new Uint8Array(48);
    u.set(uHash, 0);
    u.set(uvs, 32);
    u.set(uks, 40);
    const ue = await aesEncryptNoPad(await hash2B(utf8(userPassword), uks, empty), new Uint8Array(16), fileKey);

    const ovs = pseudoRandom(33, 8);
    const oks = pseudoRandom(44, 8);
    const oHash = await hash2B(utf8(ownerPassword), ovs, u);
    const o = new Uint8Array(48);
    o.set(oHash, 0);
    o.set(ovs, 32);
    o.set(oks, 40);
    const oe = await aesEncryptNoPad(await hash2B(utf8(ownerPassword), oks, u), new Uint8Array(16), fileKey);

    // /Perms is one AES block in ECB, which for a single block is CBC with a
    // zero IV. Readers check it, so a fixture without it is not a fair test.
    const perms = new Uint8Array(16);
    new DataView(perms.buffer).setInt32(0, permissions, true);
    perms.set([0xff, 0xff, 0xff, 0xff], 4);
    perms[8] = 0x54; // 'T' — metadata is encrypted
    perms.set(utf8('adb'), 9);
    perms.set(pseudoRandom(55, 4), 12);

    Object.assign(encryptEntries, {
      U: toHexString(u),
      O: toHexString(o),
      UE: toHexString(ue),
      OE: toHexString(oe),
      Perms: toHexString(await aesEncryptNoPad(fileKey, new Uint8Array(16), perms)),
      CF: { StdCF: { CFM: 'AESV3', Length: 32 } },
      StmF: 'StdCF',
      StrF: 'StdCF',
    });
    info = {
      v: 5, r: 6, keyBytes: 32, o, u, oe, ue,
      permissions, encryptMetadata: true, streams: 'aes256', strings: 'aes256', id,
    };
  } else {
    const o = computeO(variant, userPassword, ownerPassword, encoding);
    info = {
      v: variant.v, r: variant.r, keyBytes: variant.keyBytes,
      o, u: new Uint8Array(32), oe: null, ue: null,
      permissions, encryptMetadata: true,
      streams: variant.cipher === 'rc4' ? 'rc4' : 'aes128',
      strings: variant.cipher === 'rc4' ? 'rc4' : 'aes128',
      id,
    };
    fileKey = fileKeyFromPadded(info, pad32(userPassword, encoding));

    const u = new Uint8Array(32);
    u.set(expectedU(info, fileKey).subarray(0, variant.r === 2 ? 32 : 16), 0);
    if (variant.r >= 3) u.set(pseudoRandom(66, 16), 16);
    info = { ...info, u };

    Object.assign(encryptEntries, { O: toHexString(o), U: toHexString(u) });
    if (variant.v === 4) {
      Object.assign(encryptEntries, {
        CF: { StdCF: { CFM: variant.cipher === 'rc4' ? 'V2' : 'AESV2', Length: variant.keyBytes } },
        StmF: 'StdCF',
        StrF: 'StdCF',
      });
    }
  }

  const encryptRef = ctx.register(ctx.obj(encryptEntries));
  ctx.trailerInfo.Encrypt = encryptRef;

  const aes = variant.cipher !== 'rc4';
  let ivSeed = 1000;
  const encrypt = async (data: Uint8Array, num: number, gen: number): Promise<Uint8Array> => {
    const key = objectKey(info, fileKey, num, gen, aes);
    if (!aes) return rc4(key, data);
    return aesEncryptStream(key, pseudoRandom(ivSeed++, 16), data);
  };

  for (const [ref, object] of ctx.enumerateIndirectObjects()) {
    if (ref === encryptRef) continue;

    if (object instanceof PDFRawStream) {
      const sealed = await encrypt(object.contents, ref.objectNumber, ref.generationNumber);
      object.dict.set(PDFName.of('Length'), PDFNumber.of(sealed.length));
      ctx.assign(ref, PDFRawStream.of(object.dict, sealed));
    }

    const holder = object instanceof PDFStream ? object.dict : object;
    for (const slot of findStrings(ctx, holder)) {
      slot.write(toHexString(await encrypt(slot.read(), ref.objectNumber, ref.generationNumber)));
    }
  }

  // No object streams: pdf-lib dissolves them while parsing, and an encrypted
  // one will not inflate, so a fixture with them tests the refusal rather than
  // the unlocking. That refusal has its own check further down.
  return { bytes: await doc.save({ useObjectStreams: false }), userPassword, ownerPassword };
}

/**
 * The layout the unlocker cannot reach, built for real rather than faked.
 *
 * It has to be assembled from raw bytes, because pdf-lib dissolves object
 * streams the moment it parses a file — which is the whole reason the unlocker
 * cannot handle these. So this encrypts the streams where they lie. RC4 keeps
 * the length, so no offset moves, and the encryption dictionary goes into the
 * cross-reference stream's own dictionary as a direct value: adding it as a new
 * object would need an entry in a cross-reference table that is already written.
 */
async function lockWithObjectStreams(): Promise<Locked> {
  const source = await PDFDocument.create();
  source.addPage([300, 400]).drawText('packed away');
  const plain = await source.save({ useObjectStreams: true });

  const userPassword = 'objstm';
  const id = pseudoRandom(4242, 16);
  const variant: Variant = { label: 'objstm', v: 2, r: 3, keyBytes: 16, cipher: 'rc4' };
  const permissions = -3904;

  const o = computeO(variant, userPassword, '', 'latin1');
  let info: Encryption = {
    v: 2, r: 3, keyBytes: 16, o, u: new Uint8Array(32), oe: null, ue: null,
    permissions, encryptMetadata: true, streams: 'rc4', strings: 'rc4', id,
  };
  const fileKey = fileKeyFromPadded(info, pad32(userPassword, 'latin1'));
  const u = new Uint8Array(32);
  u.set(expectedU(info, fileKey).subarray(0, 16), 0);
  u.set(pseudoRandom(77, 16), 16);
  info = { ...info, u };

  const bytes = new Uint8Array(plain);
  const text = Buffer.from(plain).toString('latin1');

  // Every stream in the file gets encrypted where it sits, except the
  // cross-reference stream, which never is.
  const objectPattern = /(\d+)\s+(\d+)\s+obj/g;
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(text))) {
    const num = Number(match[1]);
    const gen = Number(match[2]);
    const endobj = text.indexOf('endobj', match.index);
    const streamAt = text.indexOf('stream', match.index);
    if (streamAt < 0 || streamAt > endobj) continue;
    if (text.slice(match.index, streamAt).includes('/Type /XRef')) continue;

    let start = streamAt + 6;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    const end = text.indexOf('endstream', start);
    const payload = bytes.subarray(start, end).slice();
    bytes.set(rc4(objectKey(info, fileKey, num, gen, false), payload), start);
  }

  const hex = (b: Uint8Array) => {
    let out = '';
    for (const x of b) out += x.toString(16).padStart(2, '0').toUpperCase();
    return out;
  };
  const encryptDict =
    `/Encrypt<</Filter/Standard/V 2/R 3/Length 128/P ${permissions}` +
    `/O<${hex(o)}>/U<${hex(u)}>>>/ID[<${hex(id)}><${hex(id)}>]`;

  // Inserted inside the cross-reference stream's dictionary, which sits after
  // everything the table points at, so no recorded offset changes.
  const xrefAt = text.indexOf('/Type /XRef');
  const dictEnd = text.indexOf('>>', xrefAt);
  const out = new Uint8Array(bytes.length + encryptDict.length);
  out.set(bytes.subarray(0, dictEnd), 0);
  out.set(new TextEncoder().encode(encryptDict), dictEnd);
  out.set(bytes.subarray(dictEnd), dictEnd + encryptDict.length);

  return { bytes: out, userPassword, ownerPassword: '' };
}

// ---------------------------------------------------------------------------
// the independent judge
// ---------------------------------------------------------------------------

async function readWithPdfjs(bytes: Uint8Array, password?: string) {
  const doc = (await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    ...(password === undefined ? {} : { password }),
  }).promise) as unknown as {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  };
  let text = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    text += content.items.map((i) => (i as { str?: string }).str ?? '').join('');
  }
  return { pages: doc.numPages, text };
}

// ---------------------------------------------------------------------------

function ctxWith(): OperationContext & { warnings: AppError[] } {
  const warnings: AppError[] = [];
  return {
    warnings,
    onProgress: () => {},
    throwIfAborted: () => {},
    warn: (w: AppError) => warnings.push(w),
  };
}

/** A document with something in every place encryption reaches. */
async function sampleDocument(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([320, 420]).drawText('PAGE ONE');
  doc.addPage([320, 420]).drawText('PAGE TWO');
  doc.setTitle('เอกสารลับ');
  doc.setAuthor('Anurak');
  doc.setSubject('a subject line, which lives in a string');
  return doc.save({ useObjectStreams: false });
}

export async function runUnlockChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  fs.mkdirSync(OUT, { recursive: true });

  console.log('\n=== ปลดล็อกรหัสผ่าน ===');

  const plain = await sampleDocument();
  const expected = await readWithPdfjs(plain);

  for (const variant of VARIANTS) {
    const locked = await lock(plain, variant, 'ผู้ใช้123', 'owner-secret');

    // 1. is it really locked? pdf.js decides, not us.
    let refusedWithout = false;
    try {
      await readWithPdfjs(locked.bytes);
    } catch (e) {
      refusedWithout = (e as Error).name === 'PasswordException';
    }
    check(`${variant.label}: pdf.js ไม่ยอมเปิดถ้าไม่มีรหัส`, refusedWithout);

    let opened = { pages: 0, text: '' };
    try {
      opened = await readWithPdfjs(locked.bytes, locked.userPassword);
    } catch (e) {
      check(`${variant.label}: pdf.js เปิดได้ด้วยรหัสที่ถูก`, false, (e as Error).message.slice(0, 60));
      continue;
    }
    check(`${variant.label}: pdf.js เปิดได้ด้วยรหัสที่ถูก และอ่านเนื้อหาตรง`,
      opened.text === expected.text && opened.pages === expected.pages,
      `${opened.pages} หน้า ${JSON.stringify(opened.text.slice(0, 20))}`);

    // 2. pdf-lib must refuse it, which is why the tool exists at all
    let pdfLibRefused = false;
    try {
      await PDFDocument.load(locked.bytes);
    } catch {
      pdfLibRefused = true;
    }
    check(`${variant.label}: ตัวเขียนไฟล์ปฏิเสธไฟล์ที่ล็อก (เหตุผลที่ต้องมีเครื่องมือนี้)`, pdfLibRefused);

    // 3. now unlock it
    const file: JobFile = { id: variant.label, name: 'ล็อกไว้.pdf', bytes: locked.bytes };
    const runCtx = ctxWith();
    const result = await unlockOperation.run([file], { password: locked.userPassword }, runCtx);
    const out = result.files[0];

    // Silence is the assertion. A spurious "parts would not decrypt" was
    // hiding here for exactly as long as nothing checked for it.
    check(`${variant.label}: ไม่มีคำเตือนหลอกหลงเหลือ`, runCtx.warnings.length === 0,
      runCtx.warnings.map((w) => w.code).join(' '));

    const reopened = await readWithPdfjs(out.bytes);
    check(`${variant.label}: ปลดแล้วเปิดได้โดยไม่ต้องใส่รหัส`, reopened.pages === expected.pages,
      `${reopened.pages} หน้า`);
    check(`${variant.label}: เนื้อหาเหมือนต้นฉบับทุกตัวอักษร`, reopened.text === expected.text,
      reopened.text === expected.text ? '' : JSON.stringify(reopened.text.slice(0, 40)));

    const back = await PDFDocument.load(out.bytes);
    check(`${variant.label}: ไม่มี /Encrypt เหลืออยู่`, back.context.trailerInfo.Encrypt === undefined);
    check(`${variant.label}: ชื่อเรื่องภาษาไทยรอด`, back.getTitle() === 'เอกสารลับ', String(back.getTitle()));
    check(`${variant.label}: ข้อมูลผู้สร้างเดิมไม่ถูกเขียนทับ`,
      back.getAuthor() === 'Anurak' && back.getSubject()?.startsWith('a subject line') === true,
      `${back.getAuthor()} / ${back.getSubject()}`);

    // 4. the owner password opens it too — people rarely know which they hold
    const viaOwner = await unlockOperation.run([file], { password: locked.ownerPassword }, ctxWith());
    check(`${variant.label}: รหัสเจ้าของก็เปิดได้`,
      (await readWithPdfjs(viaOwner.files[0].bytes)).text === expected.text);

    // 5. and a wrong one is refused rather than producing noise
    const wrong = await runJob(createJob('unlock', [file], { password: 'ไม่ใช่รหัสนี้' }));
    check(`${variant.label}: รหัสผิดถูกปฏิเสธ ไม่ใช่เขียนไฟล์มั่ว`,
      wrong.error?.code === 'E_WRONG_PASSWORD', wrong.error?.code ?? wrong.state);

    fs.writeFileSync(path.join(OUT, `unlock-${variant.v}-${variant.r}.pdf`), out.bytes);
  }

  // --- a Thai password, encoded the way each side of history did it ---------
  {
    // Readers below revision 5 keep the low byte of each character; some
    // producers used UTF-8 anyway. Both files exist, so both have to open — and
    // this is the check that caught the bug, by way of pdf.js disagreeing.
    for (const encoding of ['latin1', 'utf8'] as const) {
      const locked = await lock(plain, VARIANTS[1], 'รหัสไทย', 'owner', -3904, encoding);
      const result = await unlockOperation.run(
        [{ id: encoding, name: 'ไทย.pdf', bytes: locked.bytes }],
        { password: 'รหัสไทย' },
        ctxWith(),
      );
      check(`รหัสผ่านภาษาไทยที่เข้ารหัสแบบ ${encoding}: เปิดได้`,
        (await readWithPdfjs(result.files[0].bytes)).text === expected.text);
    }

    const reader = await lock(plain, VARIANTS[1], 'รหัสไทย', 'owner', -3904, 'latin1');
    let pdfjsAgrees = false;
    try {
      pdfjsAgrees = (await readWithPdfjs(reader.bytes, 'รหัสไทย')).text === expected.text;
    } catch {
      pdfjsAgrees = false;
    }
    check('และแบบที่โปรแกรมอ่าน PDF จริงใช้ ตรงกับที่ pdf.js คาด', pdfjsAgrees);
  }

  // --- the "cannot print or copy" case: no password at all ------------------
  {
    const locked = await lock(plain, VARIANTS[2], '', 'stop-printing');
    const openedFreely = await readWithPdfjs(locked.bytes);
    check('ล็อกแบบห้ามพิมพ์ (รหัสผู้ใช้ว่าง): เปิดอ่านได้เลย',
      openedFreely.text === expected.text);

    const result = await unlockOperation.run(
      [{ id: 'p', name: 'ห้ามพิมพ์.pdf', bytes: locked.bytes }],
      { ...UNLOCK_DEFAULTS },
      ctxWith(),
    );
    const back = await PDFDocument.load(result.files[0].bytes);
    check('ปลดล็อกได้โดยไม่ต้องกรอกอะไร', back.context.trailerInfo.Encrypt === undefined);
    check('และเนื้อหายังครบ', (await readWithPdfjs(result.files[0].bytes)).text === expected.text);
  }

  // --- a file that was never locked -----------------------------------------
  {
    const ctx = ctxWith();
    const result = await unlockOperation.run(
      [{ id: 'n', name: 'ธรรมดา.pdf', bytes: plain }],
      { password: '' },
      ctx,
    );
    check('ไฟล์ที่ไม่ได้ล็อก: คืนต้นฉบับ ไม่ใช่ error',
      result.files[0].bytes.byteLength === plain.byteLength,
      `${plain.byteLength} -> ${result.files[0].bytes.byteLength}`);
    check('และบอกว่าไม่ได้ทำอะไร',
      ctx.warnings.some((w) => w.code === 'W_NOTHING_CHANGED'),
      ctx.warnings.map((w) => w.code).join(' '));
  }

  // --- the structure it cannot reach, refused rather than mangled -----------
  {
    const packed = await lockWithObjectStreams();

    // Genuinely locked, not merely claimed to be: pdf.js opens it only with the
    // password, which is what makes the refusal below a real refusal.
    let refusedWithout = false;
    try {
      await readWithPdfjs(packed.bytes);
    } catch (e) {
      refusedWithout = (e as Error).name === 'PasswordException';
    }
    check('ไฟล์ที่เก็บวัตถุในสตรีมซ้อน: ล็อกจริง (pdf.js ไม่ยอมเปิดถ้าไม่มีรหัส)', refusedWithout);
    check('และเปิดได้ด้วยรหัสที่ถูก',
      (await readWithPdfjs(packed.bytes, packed.userPassword)).pages === 1);

    const job = await runJob(
      createJob('unlock', [{ id: 'o', name: 'objstm.pdf', bytes: packed.bytes }], { password: packed.userPassword }),
    );
    check('โครงแบบนี้: ปฏิเสธพร้อมบอกเหตุผล ไม่ใช่เขียนไฟล์ที่ขาดวัตถุ',
      job.error?.code === 'E_UNSUPPORTED_ENCRYPTION', job.error?.code ?? job.state);
    check('คำปฏิเสธบอกด้วยว่าติดตรงไหน',
      (job.error?.hint?.th ?? '').includes('สตรีมซ้อน'), job.error?.hint?.th ?? '');
  }

  // --- and the one real locked document on this machine ---------------------
  {
    const real = fixture('lockedCertificate');
    if (!fs.existsSync(real)) {
      console.log('  (ไม่มีไฟล์ล็อกจริงบนเครื่องนี้ — ข้ามการตรวจกับของจริง)');
    } else {
      const bytes = new Uint8Array(fs.readFileSync(real));
      const before = await readWithPdfjs(bytes, '');
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const info = readEncryption(doc);
      check('ของจริง: อ่านชนิดการเข้ารหัสออก',
        info !== null && !('unsupported' in info) && info.v === 2 && info.r === 3,
        info && 'unsupported' in info ? info.unsupported : info ? `V${info.v} R${info.r}` : 'ไม่มี');

      const result = await unlockOperation.run(
        [{ id: 'r', name: 'หนังสือรับรอง.pdf', bytes }],
        { password: '' },
        ctxWith(),
      );
      const after = await readWithPdfjs(result.files[0].bytes);
      check('ของจริง: ปลดแล้วเปิดได้โดยไม่ต้องมีรหัส และข้อความไทยครบ',
        after.pages === before.pages && after.text === before.text,
        `${before.pages} หน้า · ${before.text.length} ตัวอักษร -> ${after.text.length}`);

      const reopened = await PDFDocument.load(result.files[0].bytes);
      check('ของจริง: ตัวเขียนไฟล์เปิดผลลัพธ์ได้แล้ว (เดิมเปิดไม่ได้)',
        reopened.getPageCount() === before.pages, String(reopened.getPageCount()));
      fs.writeFileSync(path.join(OUT, 'unlock-real.pdf'), result.files[0].bytes);
    }
  }

  // --- the pieces on their own ----------------------------------------------
  {
    const info: Encryption = {
      v: 2, r: 3, keyBytes: 16,
      o: pseudoRandom(1, 32), u: new Uint8Array(32), oe: null, ue: null,
      permissions: -1, encryptMetadata: true, streams: 'rc4', strings: 'rc4', id: pseudoRandom(2, 16),
    };
    const key = fileKeyFromPadded(info, pad32('hello', 'latin1'));
    check('คีย์ของแต่ละวัตถุไม่ซ้ำกัน',
      Buffer.compare(
        Buffer.from(objectKey(info, key, 12, 0, false)),
        Buffer.from(objectKey(info, key, 13, 0, false)),
      ) !== 0);
    check('คีย์ RC4 128 บิตยาว 16 ไบต์', objectKey(info, key, 1, 0, false).length === 16);

    const decryptor = new Decryptor(info, key);
    const message = utf8('ข้อความที่ต้องกลับมาเหมือนเดิม');
    const sealed = rc4(objectKey(info, key, 7, 0, false), message);
    const opened = await decryptor.stream(sealed, 7, 0);
    check('ถอดรหัสแล้วได้ไบต์เดิมเป๊ะ',
      opened !== null && Buffer.compare(Buffer.from(opened), Buffer.from(message)) === 0);
    const wrongObject = await decryptor.stream(sealed, 8, 0);
    check('ถอดด้วยหมายเลขวัตถุผิด ได้คนละเรื่อง (จึงต้องเช็ครหัสก่อนเสมอ)',
      wrongObject !== null && Buffer.compare(Buffer.from(wrongObject), Buffer.from(message)) !== 0);
  }

  return failures;
}
