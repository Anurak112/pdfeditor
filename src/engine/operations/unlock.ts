/**
 * Unlock — take the password off a document you can already open.
 *
 * The narrow reading is the only defensible one: this removes protection from a
 * file whose password the person has, which is what somebody archiving their
 * own bank statements needs and what every one of these sites offers. It does
 * not guess, and it does not try a list. A wrong password is answered with "that
 * is not it", once, and nothing else.
 *
 * The work is small; the care is in knowing when not to do it. A decryption run
 * with the wrong key does not fail — it succeeds and writes a document full of
 * noise. So the password is checked against the file's own verifier before a
 * single byte is touched, and a structure this cannot handle is named and
 * refused rather than half-processed.
 */
import { PDFName, PDFNumber, PDFRawStream, PDFStream } from 'pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { appError, appWarning } from '../errors';
import { asPdfName, stem } from '../naming';
import { Decryptor, findStrings, readEncryption, toHexString, unlock } from '../decrypt';
import type { Encryption } from '../decrypt';
import { span } from '../types';
import type { JobFile, OperationContext, OperationResult, PdfOperation } from '../types';

export interface UnlockOptions {
  password: string;
}

export const UNLOCK_DEFAULTS: UnlockOptions = {
  password: '',
};

/**
 * pdf-lib dissolves object streams while parsing, and an encrypted one will not
 * inflate — so the parse fails before there is anything to decrypt. Reaching
 * those would mean decrypting the raw bytes ahead of the parser, which is a
 * different piece of work; until it exists this says so plainly rather than
 * writing out a document with objects missing.
 */
const HAS_OBJECT_STREAMS = /\/Type\s*\/ObjStm/;

function looksEncrypted(bytes: Uint8Array): boolean {
  // Only the tail matters — /Encrypt lives in the trailer or an xref stream dict.
  const window = bytes.subarray(Math.max(0, bytes.length - 4096));
  return /\/Encrypt/.test(new TextDecoder('latin1').decode(window));
}

function refusalFor(bytes: Uint8Array, detail: string) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
  if (HAS_OBJECT_STREAMS.test(text) && looksEncrypted(bytes)) {
    return appError('E_UNSUPPORTED_ENCRYPTION', {
      hint: {
        th: 'ไฟล์นี้เข้ารหัสแบบที่เก็บวัตถุไว้ในสตรีมซ้อนกัน — ตัวปลดล็อกยังอ่านโครงแบบนี้ไม่ได้',
        en: 'This file packs its objects into compressed streams, and the unlocker cannot read that layout yet',
      },
      detail,
    });
  }
  return appError('E_CORRUPT', { detail });
}

function isXRefOrUnencryptedMetadata(stream: PDFStream, info: Encryption): boolean {
  const type = stream.dict.get(PDFName.of('Type'));
  const name = type instanceof PDFName ? type.asString() : '';
  if (name === '/XRef') return true;
  return name === '/Metadata' && !info.encryptMetadata;
}

async function run(files: JobFile[], options: UnlockOptions, ctx: OperationContext): Promise<OperationResult> {
  const file = files[0];
  if (!file) {
    throw appError('E_TOO_FEW_FILES', {
      hint: { th: 'ยังไม่ได้เลือกไฟล์', en: 'No file was chosen' },
    });
  }

  ctx.onProgress(5, { th: `กำลังเปิด ${file.name}`, en: `Opening ${file.name}` });

  let doc: PDFDocument;
  try {
    // ignoreEncryption on purpose: refusing to open it is the one thing this
    // tool cannot do, since opening it is the whole job.
    //
    // updateMetadata off matters more here than anywhere else. Left on, pdf-lib
    // replaces Producer, Creator and ModDate with its own at load — which is
    // metadata loss in every tool, but here it also plants plaintext strings in
    // a document we are about to decrypt. They then fail to decrypt, because
    // they were never encrypted, and get reported as damage. That warning is
    // how this was found.
    doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw refusalFor(file.bytes, String((e as Error)?.message ?? e));
  }

  const info = readEncryption(doc);

  if (info === null) {
    ctx.warn(
      appWarning('W_NOTHING_CHANGED', {
        hint: {
          th: 'ไฟล์นี้ไม่ได้ใส่รหัสผ่านอยู่แล้ว — คืนไฟล์เดิมให้',
          en: 'This file was not protected in the first place, so here it is unchanged',
        },
      }),
    );
    return {
      files: [{ name: file.name, bytes: file.bytes, mimeType: 'application/pdf' }],
      stats: { originalBytes: file.bytes.byteLength, outputBytes: file.bytes.byteLength },
    };
  }

  if ('unsupported' in info) {
    throw appError('E_UNSUPPORTED_ENCRYPTION', {
      hint: {
        th: `ไฟล์นี้ใช้การเข้ารหัสแบบ ${info.unsupported} ซึ่งยังรองรับไม่ได้`,
        en: `This file uses ${info.unsupported}, which is not supported`,
      },
    });
  }

  // Encrypted and packed into object streams: pdf-lib got far enough to read
  // the trailer but not far enough to have every object, so saving now would
  // quietly drop things.
  if (HAS_OBJECT_STREAMS.test(new TextDecoder('latin1').decode(file.bytes.subarray(0, 2_000_000)))) {
    throw refusalFor(file.bytes, 'encrypted document using object streams');
  }

  ctx.onProgress(12, { th: 'กำลังตรวจรหัสผ่าน', en: 'Checking the password' });

  const unlocked = await unlock(info, options.password);
  if (!unlocked) {
    throw appError('E_WRONG_PASSWORD', {
      // The hint has to add something the message did not already say, and the
      // useful thing here is that two different passwords both work.
      hint: options.password
        ? {
            th: 'ใช้ได้ทั้งรหัสสำหรับเปิดอ่าน และรหัสเจ้าของไฟล์ — ลองอีกอันดู',
            en: 'Either the password that opens it or the owner password will do — try the other one',
          }
        : {
            th: 'ไฟล์นี้ต้องใช้รหัสผ่าน — ใส่รหัสที่ใช้เปิดไฟล์',
            en: 'This file needs a password — the one you use to open it',
          },
    });
  }

  const decryptor = new Decryptor(info, unlocked.key);
  const ctxObjects = doc.context;
  const encryptRef = ctxObjects.trailerInfo.Encrypt;
  const encryptKey =
    encryptRef && typeof encryptRef === 'object' && 'objectNumber' in encryptRef
      ? `${(encryptRef as { objectNumber: number }).objectNumber}`
      : null;

  const entries = [...ctxObjects.enumerateIndirectObjects()];
  const at = span(15, 88);
  let failed = 0;
  let streams = 0;
  let strings = 0;

  for (let i = 0; i < entries.length; i++) {
    ctx.throwIfAborted();
    if (i % 32 === 0) {
      ctx.onProgress(at(i, entries.length), {
        th: 'กำลังถอดรหัสเนื้อหา',
        en: 'Decrypting the contents',
      });
    }

    const [ref, object] = entries[i];
    // The encryption dictionary describes the lock; it was never behind it.
    if (encryptKey !== null && String(ref.objectNumber) === encryptKey) continue;

    if (object instanceof PDFRawStream && !isXRefOrUnencryptedMetadata(object, info)) {
      const plain = await decryptor.stream(object.contents, ref.objectNumber, ref.generationNumber);
      if (plain) {
        object.dict.set(PDFName.of('Length'), PDFNumber.of(plain.length));
        ctxObjects.assign(ref, PDFRawStream.of(object.dict, plain));
        streams++;
      } else {
        failed++;
      }
    }

    const holder = object instanceof PDFStream ? object.dict : object;
    for (const slot of findStrings(ctxObjects, holder)) {
      const plain = await decryptor.string(slot.read(), ref.objectNumber, ref.generationNumber);
      if (plain) {
        slot.write(toHexString(plain));
        strings++;
      } else {
        failed++;
      }
    }
  }

  if (failed > 0) {
    ctx.warn(
      appWarning('W_PARTIAL_DECRYPT', {
        hint: {
          th: `มี ${failed} ส่วนในไฟล์ที่ถอดรหัสไม่ผ่าน — ส่วนนั้นถูกปล่อยไว้เหมือนเดิม`,
          en: `${failed} pieces of the file would not decrypt and were left as they were`,
        },
      }),
    );
  }

  ctx.onProgress(92, { th: 'กำลังเขียนไฟล์', en: 'Writing the file' });

  // The lock comes off here, and only after every object behind it was opened.
  ctxObjects.trailerInfo.Encrypt = undefined;

  const bytes = await doc.save({ useObjectStreams: true });

  return {
    files: [{ name: asPdfName(`${stem(file.name)}-ปลดล็อกแล้ว`), bytes, mimeType: 'application/pdf' }],
    stats: {
      originalBytes: file.bytes.byteLength,
      outputBytes: bytes.byteLength,
      pagesProcessed: doc.getPageCount(),
      replacements: streams + strings,
    },
  };
}

export const unlockOperation: PdfOperation<UnlockOptions> = { id: 'unlock', run };
