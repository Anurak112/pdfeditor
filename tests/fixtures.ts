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
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
export const DOWNLOADS = path.join(HOME, 'Downloads');

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
  console.log('  ไฟล์พวกนี้เป็นเอกสารจริง จึงไม่ได้อยู่ใน repo — บนเครื่องคุณนุขาจะรันครบ');
}
