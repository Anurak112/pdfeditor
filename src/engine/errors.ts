/**
 * Every way this app is allowed to fail.
 *
 * Two rules, both learned from watching real users hit real broken PDFs: the
 * user never sees a code or a stack trace, and every error carries at least one
 * action they can actually press. An error with no way out is a dead end, and a
 * dead end becomes a support message.
 */
import type { LocalizedString } from './types';

/**
 * Whether this stops the work or just accompanies it.
 *
 * Warnings were originally borrowing error codes — the page-size caveat went
 * out as E_BAD_OPTIONS, which is a lie twice over: nothing was invalid and
 * nothing failed. Once the second tool copied that shape it would have been
 * permanent, so the two are separate kinds now.
 */
export type Severity = 'error' | 'warning';

export type ErrorCode =
  | 'E_NOT_PDF'
  | 'E_CORRUPT'
  | 'E_ENCRYPTED'
  | 'E_TOO_LARGE'
  | 'E_TOO_MANY_PAGES'
  | 'E_TOO_FEW_FILES'
  | 'E_TOO_MANY_FILES'
  | 'E_EMPTY_FILE'
  | 'E_NO_PAGES_SELECTED'
  | 'E_RANGE_OUT_OF_BOUNDS'
  | 'E_NO_TEXT_LAYER'
  | 'E_TEXT_NOT_FOUND'
  | 'E_OUT_OF_MEMORY'
  | 'E_CANCELLED'
  | 'E_SERVER_UNAVAILABLE'
  | 'E_NOT_BUILT_YET'
  | 'E_BAD_OPTIONS'
  | 'E_INTERNAL'
  | 'E_UNSUPPORTED_CONVERSION'
  | 'E_UNSUPPORTED_ENCRYPTION'
  | 'E_WRONG_PASSWORD';

/** Things worth saying while the work still succeeds. */
export type WarningCode =
  | 'W_FILE_SKIPPED'
  | 'W_RANGE_CLAMPED'
  | 'W_PAGE_SIZE_REDRAW'
  | 'W_FILES_DROPPED'
  | 'W_MEMORY_HIGH'
  | 'W_ALREADY_OPTIMIZED'
  | 'W_IMAGES_SKIPPED'
  | 'W_NO_MATCH_IN_FILE'
  | 'W_EDIT_OVERLAY'
  | 'W_NOTHING_CHANGED'
  | 'W_BOOKMARKS_DROPPED'
  | 'W_MANY_OUTPUTS'
  | 'W_PNG_LARGER'
  | 'W_NO_TEXT_IN_FILE'
  | 'W_PARTIAL_DECRYPT'
  | 'W_CANCELLED';

export type AnyCode = ErrorCode | WarningCode;

export type RecoveryKind = 'pick-file' | 'add-files' | 'goto-tool' | 'retry' | 'dismiss' | 'go-home';

export interface RecoveryAction {
  label: LocalizedString;
  kind: RecoveryKind;
  /**
   * Only for kind 'goto-tool'. A plain string, not the tool union: routing is
   * the UI's business, and the engine should not have to know the tool list to
   * suggest a way out.
   */
  toolId?: string;
}

export interface AppError {
  code: AnyCode;
  severity: Severity;
  message: LocalizedString;
  /** Extra context for the user — the actual size that was too big, and so on. */
  hint?: LocalizedString;
  /** Technical detail. Console and logs only, never rendered. */
  detail?: string;
  actions: RecoveryAction[];
}

const PICK: RecoveryAction = { kind: 'pick-file', label: { th: 'เลือกไฟล์อื่น', en: 'Choose another file' } };
const ADD: RecoveryAction = { kind: 'add-files', label: { th: 'เพิ่มไฟล์', en: 'Add files' } };
const RETRY: RecoveryAction = { kind: 'retry', label: { th: 'ลองอีกครั้ง', en: 'Try again' } };
const HOME: RecoveryAction = { kind: 'go-home', label: { th: 'กลับหน้าแรก', en: 'Back to start' } };
const OK: RecoveryAction = { kind: 'dismiss', label: { th: 'รับทราบ', en: 'Got it' } };

const UNLOCK: RecoveryAction = {
  kind: 'goto-tool',
  toolId: 'unlock',
  label: { th: 'ปลดล็อกด้วยรหัสผ่าน', en: 'Unlock with password' },
};
const GO_SPLIT: RecoveryAction = {
  kind: 'goto-tool',
  toolId: 'split',
  label: { th: 'แยกหน้าก่อน', en: 'Split it first' },
};
const GO_COMPRESS: RecoveryAction = {
  kind: 'goto-tool',
  toolId: 'compress',
  label: { th: 'ลดขนาดก่อน', en: 'Compress it first' },
};

interface Spec {
  message: LocalizedString;
  actions: RecoveryAction[];
}

const CATALOG: Record<ErrorCode, Spec> = {
  E_NOT_PDF: {
    message: { th: 'ไฟล์นี้ไม่ใช่ PDF', en: 'That file is not a PDF' },
    actions: [PICK],
  },
  E_CORRUPT: {
    message: { th: 'เปิดไฟล์นี้ไม่ได้ — ไฟล์อาจเสียหาย', en: 'We could not open this file — it may be damaged' },
    actions: [PICK],
  },
  E_ENCRYPTED: {
    message: { th: 'ไฟล์นี้ใส่รหัสผ่านไว้', en: 'This file is password protected' },
    actions: [UNLOCK, PICK],
  },
  E_TOO_LARGE: {
    message: { th: 'ไฟล์ใหญ่เกินกว่าที่รับได้', en: 'This file is larger than we can handle' },
    actions: [GO_COMPRESS, PICK],
  },
  E_TOO_MANY_PAGES: {
    message: { th: 'เอกสารยาวเกินกว่าที่รับได้', en: 'This document has more pages than we can handle' },
    actions: [GO_SPLIT, PICK],
  },
  E_TOO_FEW_FILES: {
    message: { th: 'ยังมีไฟล์ไม่พอสำหรับเครื่องมือนี้', en: 'This tool needs more files than that' },
    actions: [ADD],
  },
  E_TOO_MANY_FILES: {
    message: { th: 'เลือกไฟล์มากเกินกว่าที่รับได้', en: 'That is more files than this tool accepts' },
    actions: [OK],
  },
  E_EMPTY_FILE: {
    message: { th: 'ไฟล์ว่างเปล่า', en: 'That file is empty' },
    actions: [PICK],
  },
  E_NO_PAGES_SELECTED: {
    message: { th: 'ยังไม่ได้เลือกหน้า', en: 'No pages selected yet' },
    actions: [OK],
  },
  E_RANGE_OUT_OF_BOUNDS: {
    message: {
      th: 'ช่วงหน้าที่ระบุเกินจำนวนหน้าของเอกสาร',
      en: 'That page range goes past the end of the document',
    },
    actions: [OK],
  },
  E_NO_TEXT_LAYER: {
    message: {
      th: 'เอกสารนี้เป็นภาพสแกน ไม่มีข้อความให้ดึง',
      en: 'This document is a scan — there is no text layer to read',
    },
    actions: [OK, PICK],
  },
  E_TEXT_NOT_FOUND: {
    message: { th: 'ไม่พบข้อความที่ค้นหาในเอกสาร', en: 'That text does not appear in this document' },
    actions: [OK],
  },
  E_OUT_OF_MEMORY: {
    message: {
      th: 'เอกสารใหญ่เกินกว่าที่เบราว์เซอร์จะไหว',
      en: 'This document is too large for the browser to hold',
    },
    actions: [GO_SPLIT, PICK],
  },
  E_CANCELLED: {
    message: { th: 'ยกเลิกแล้ว', en: 'Cancelled' },
    actions: [OK],
  },
  E_SERVER_UNAVAILABLE: {
    message: {
      th: 'เครื่องมือนี้ต้องต่ออินเทอร์เน็ต ตอนนี้ต่อไม่ได้',
      en: 'This tool needs a connection, and we could not reach it',
    },
    actions: [RETRY, HOME],
  },
  E_NOT_BUILT_YET: {
    message: { th: 'เครื่องมือนี้ยังทำไม่เสร็จ', en: 'This tool is not finished yet' },
    actions: [HOME],
  },
  E_BAD_OPTIONS: {
    message: { th: 'ตัวเลือกที่ตั้งไว้ใช้ไม่ได้', en: 'Those settings are not valid' },
    actions: [OK],
  },
  E_UNSUPPORTED_CONVERSION: {
    message: { th: 'แปลงแบบนี้ไม่ได้', en: 'That conversion is not possible' },
    actions: [OK],
  },
  E_UNSUPPORTED_ENCRYPTION: {
    message: {
      th: 'ไฟล์นี้ใช้การเข้ารหัสแบบที่ยังรองรับไม่ได้',
      en: 'This file is locked in a way we cannot open',
    },
    actions: [OK, PICK],
  },
  E_WRONG_PASSWORD: {
    // Worded to fit an empty box as well as a wrong guess. "That is not the
    // password" reads strangely to someone who typed nothing.
    message: { th: 'เปิดไฟล์นี้ด้วยรหัสที่ใส่มาไม่ได้', en: 'That password does not open this file' },
    // No retry action: the field is right there, and a button that clears the
    // panel just makes the person type it again from a blank screen.
    actions: [OK],
  },
  E_INTERNAL: {
    message: { th: 'เกิดข้อผิดพลาดภายในโปรแกรม', en: 'Something went wrong inside the app' },
    actions: [RETRY, HOME],
  },
};

const WARNINGS: Record<WarningCode, LocalizedString> = {
  W_FILE_SKIPPED: { th: 'ข้ามไฟล์ที่ใช้ไม่ได้', en: 'A file was skipped' },
  W_RANGE_CLAMPED: { th: 'ช่วงหน้าบางส่วนเกินเอกสาร', en: 'Part of a page range went past the end' },
  W_PAGE_SIZE_REDRAW: {
    th: 'การบังคับขนาดหน้าต้องวาดหน้าใหม่ — ลิงก์และคอมเมนต์ในเอกสารเดิมจะหายไป',
    en: 'Forcing a page size redraws each page, so links and comments from the originals are lost',
  },
  W_FILES_DROPPED: { th: 'เลือกไฟล์เกินที่รับได้ บางไฟล์ถูกข้าม', en: 'Some files were skipped — too many at once' },
  W_MEMORY_HIGH: {
    th: 'เปิดไฟล์รวมกันค่อนข้างใหญ่ — เครื่องอาจทำงานช้าลง',
    en: 'That is a lot open at once — things may get slow',
  },
  W_ALREADY_OPTIMIZED: {
    th: 'ไฟล์นี้ถูกบีบมาดีแล้ว — ไม่มีอะไรให้ลดเพิ่ม',
    en: 'This file is already well compressed — there was nothing left to save',
  },
  W_IMAGES_SKIPPED: {
    th: 'บางภาพในไฟล์แตะไม่ได้ — ปล่อยไว้เหมือนเดิม',
    en: 'Some images could not be touched and were left exactly as they were',
  },
  W_NO_MATCH_IN_FILE: {
    th: 'บางไฟล์ไม่มีข้อความที่ค้นหา — ไฟล์นั้นไม่ถูกแก้',
    en: 'Some files did not contain the text, so they were left alone',
  },
  W_EDIT_OVERLAY: {
    th: 'บางจุดแก้ในไฟล์ตรง ๆ ไม่ได้ ต้องวาดทับแทน — ข้อความเดิมจะยังค้างอยู่ถ้าก๊อปออกมา',
    en: 'Some spots could not be edited in place and were painted over — copying the text still shows the old value',
  },
  W_NOTHING_CHANGED: {
    th: 'ไม่ได้เปลี่ยนอะไรเลย — ไฟล์ที่ได้เหมือนต้นฉบับ',
    en: 'Nothing was changed, so the result matches the original',
  },
  W_BOOKMARKS_DROPPED: {
    th: 'สารบัญเดิมหายไป เพราะหน้าถูกย้ายหรือลบ',
    en: 'The original bookmarks are gone, because pages moved or were removed',
  },
  W_MANY_OUTPUTS: {
    th: 'จะได้ไฟล์จำนวนมาก — รวมกันแล้วขนาดไม่น้อย',
    en: 'This produces a lot of files, and they add up',
  },
  W_PNG_LARGER: {
    th: 'PNG ไฟล์ใหญ่กว่า JPG หลายเท่า — เลือก JPG ถ้าไม่ต้องการพื้นโปร่งใส',
    en: 'PNG files are several times larger than JPG — pick JPG unless you need transparency',
  },
  W_NO_TEXT_IN_FILE: {
    th: 'บางไฟล์ไม่มีชั้นข้อความ — ไฟล์นั้นข้ามไป',
    en: 'Some files had no text layer and were skipped',
  },
  W_PARTIAL_DECRYPT: {
    th: 'บางส่วนของไฟล์ถอดรหัสไม่ผ่าน — ส่วนนั้นถูกปล่อยไว้เหมือนเดิม',
    en: 'Parts of the file would not decrypt and were left as they were',
  },
  W_CANCELLED: { th: 'ยกเลิกแล้ว — ไฟล์ที่เปิดไว้ยังอยู่ครบ', en: 'Cancelled — your files are still loaded' },
};

export function appError(code: ErrorCode, extra?: { hint?: LocalizedString; detail?: string }): AppError {
  const spec = CATALOG[code];
  return { code, severity: 'error', message: spec.message, actions: spec.actions, ...extra };
}

/**
 * A note that rides along with a successful run.
 *
 * Always dismissible and never anything else: a warning that offers "choose
 * another file" is really an error wearing the wrong colour.
 */
export function appWarning(code: WarningCode, extra?: { hint?: LocalizedString; detail?: string }): AppError {
  return { code, severity: 'warning', message: WARNINGS[code], actions: [OK], ...extra };
}

/** For tools whose engine has not been written yet, so the UI can say so plainly. */
export function notBuiltYet(toolName: LocalizedString): AppError {
  return appError('E_NOT_BUILT_YET', {
    hint: {
      th: toolName.th + ' อยู่ในแผนแล้ว แต่ยังไม่ได้ลงมือ — วางโครง UI ก่อน แล้วเดินทีละเครื่องมือ',
      en: toolName.en + ' is planned but not built yet — the shell lands first, then one tool at a time',
    },
  });
}

/** Things pdf-lib and pdf.js say when the document itself is the problem. */
const LOOKS_LIKE_BAD_PDF =
  /pdf (header|document)|parse|xref|trailer|invalid object|unexpected (object|token)|corrupt|malformed|stream/i;

/**
 * Wraps anything thrown out of a tool into something renderable.
 *
 * The default used to be E_CORRUPT, which quietly blamed the user's file for
 * every bug we wrote. A DataCloneError from our own postMessage was reported as
 * "this file may be damaged" — sending someone off to re-export a perfectly
 * good invoice. Only errors that actually read like a broken document get that
 * message now; everything else admits it is our fault.
 */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'code' in e && 'actions' in e) return e as AppError;
  if (e instanceof DOMException && e.name === 'AbortError') return appError('E_CANCELLED');

  const detail = e instanceof Error ? e.name + ': ' + e.message : String(e);
  if (/out of memory|allocation (size overflow|failed)/i.test(detail)) {
    return appError('E_OUT_OF_MEMORY', { detail });
  }
  if (/password|encrypted/i.test(detail)) return appError('E_ENCRYPTED', { detail });
  if (LOOKS_LIKE_BAD_PDF.test(detail)) return appError('E_CORRUPT', { detail });
  return appError('E_INTERNAL', { detail });
}
