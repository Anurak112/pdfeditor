/**
 * Documents that live on one laptop, not in this repository.
 *
 * The strongest checks here run against real files — a Thai bill, a locked
 * company certificate, a 36 MB deck — and those cannot be committed: they are
 * somebody's actual invoices. So on any other machine, and on CI, they are not
 * there.
 *
 * Two ways to handle that, and only one of them is honest. Failing is wrong:
 * a green build should not depend on which laptop it ran on. Skipping quietly
 * is worse: the run says ALL CHECKS PASSED while a third of it never executed,
 * which is exactly how an untested path rots without anyone noticing.
 *
 * So skips are recorded and counted, and the run prints what it did not do.
 *
 * Their *names* are not in here either, and that is the second lesson. Keeping
 * the bytes out was never enough: a filename of the form
 * `<customer>_<document-type>_<invoice-number>_FINAL.pdf` names a customer and
 * an invoice number all on its own, and several sat in this repository in plain
 * text while the repository was public. The same goes for what the tests assert
 * is *inside* those documents. Both now come from
 * `tests/fixtures.local.json`, which git ignores. Copy
 * `tests/fixtures.example.json` over it and fill in what is on your disk; every
 * key you leave out simply becomes a recorded skip, which is the behaviour this
 * file already had for missing files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
export const DOWNLOADS = path.join(HOME, 'Downloads');

/**
 * What each document is *for*, which is the only thing the tests care about.
 * The mapping from these to real filenames is local to whoever has the files.
 */
export type FixtureKey =
  | 'thaiBill'           // Thai invoice from a word processor — 1-byte font, no spaces between words
  | 'invoiceWithLogo'    // invoice carrying an oversized logo — the compress and worker fixture
  | 'textOnlyDeck'       // long document with no images at all — compress has nothing to win
  | 'lockedCertificate'  // real RC4-encrypted document, the only true unlock fixture
  | 'jobInvoice'         // the two documents the tool was first written for: an address edit
  | 'jobReceipt';

type Config = Partial<Record<FixtureKey, string>> & {
  /** Folder holding `jobInvoice` / `jobReceipt`, relative to Downloads. */
  jobFolder?: string;
  /** Strings a test expects to find inside a document — also somebody's data. */
  text?: Partial<Record<FixtureKey, Record<string, string>>>;
};

const CONFIG_FILE = path.join(import.meta.dirname, 'fixtures.local.json');

function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
  } catch {
    // No config, or unreadable: every lookup becomes a skip, which is exactly
    // what happens on CI and on anyone else's machine.
    return {};
  }
}

const config = loadConfig();

/**
 * Absolute path to a real document, or a path that cannot exist when this
 * machine has not been told where it is. Callers already handle "not there" —
 * they call `haveFixture`, or `fs.existsSync` — so an unconfigured key needs no
 * special case anywhere else.
 */
export function fixture(key: FixtureKey): string {
  const name = config[key];
  if (!name) return path.join(DOWNLOADS, `__fixture-not-configured__${key}`);
  if (key === 'jobInvoice' || key === 'jobReceipt') return path.join(jobFolder(), name);
  return path.join(DOWNLOADS, name);
}

/** Where the two job documents live. */
export function jobFolder(): string {
  return path.join(DOWNLOADS, config.jobFolder ?? '__job-folder-not-configured__');
}

/**
 * A string the test expects to read out of a real document — an invoice number,
 * a company name. Null when this machine has not been told it, in which case
 * the caller skips that check rather than asserting on a placeholder.
 */
export function docText(key: FixtureKey, field: string): string | null {
  return config.text?.[key]?.[field] ?? null;
}

/** For messages: what the document is, never what it is called. */
export const FIXTURE_LABEL: Record<FixtureKey, string> = {
  thaiBill: 'ใบวางบิลไทย (ฟอนต์ 1 ไบต์)',
  invoiceWithLogo: 'ใบแจ้งหนี้ + โลโก้ความละเอียดสูง',
  textOnlyDeck: 'เอกสารข้อความล้วน ไม่มีภาพเลย',
  lockedCertificate: 'เอกสารที่ใส่รหัสผ่านจริง',
  jobInvoice: 'งานจริง: ใบแจ้งหนี้',
  jobReceipt: 'งานจริง: ใบเสร็จ',
};

interface Skip {
  label: string;
  file: string;
}

const skips: Skip[] = [];

/**
 * True when the file is here. When it is not, the reason is remembered rather
 * than printed and forgotten, so the end of the run can total it up.
 */
export function haveFixture(file: string, label: string): boolean {
  if (fs.existsSync(file)) return true;
  skips.push({ label, file });
  return false;
}

/** `haveFixture` for a keyed document, so no call site has to name a file. */
export function haveDoc(key: FixtureKey, label = FIXTURE_LABEL[key]): boolean {
  return haveFixture(fixture(key), label);
}

export function fixtureSkips(): readonly Skip[] {
  return skips;
}

/** Printed at the end of the run, next to the pass count, never instead of it. */
export function reportFixtureSkips(): void {
  if (skips.length === 0) {
    console.log('\nไฟล์ทดสอบจริงครบทุกตัว — ไม่มีอะไรถูกข้าม');
    return;
  }
  console.log(`\n${skips.length} ชุดถูกข้าม เพราะไม่มีไฟล์จริงบนเครื่องนี้ (ไม่ใช่ความล้มเหลว):`);
  for (const skip of skips) console.log(`  · ${skip.label}`);
  console.log('  ไฟล์พวกนี้เป็นเอกสารจริง จึงไม่ได้อยู่ใน repo — ตั้งชื่อไฟล์ได้ที่ tests/fixtures.local.json');
}
