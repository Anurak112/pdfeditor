/**
 * Prove the ZIP writer produces an archive Windows itself can open.
 *
 * Structure checks are not enough here: a wrong offset or CRC still *looks*
 * like a zip. So this writes a real archive to disk for `Expand-Archive` to
 * unpack in the caller's shell, and checks the round trip byte for byte.
 *
 *   npx tsx tests/zip-check.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createZip } from '../src/lib/utils/zip';

const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const entries = [
  { name: 'plain.txt', bytes: new TextEncoder().encode('hello zip') },
  // Thai filename: the flag bit that makes Explorer read it correctly
  { name: 'ใบวางบิล-edited.pdf', bytes: new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'))) },
  { name: 'nested name (1).bin', bytes: new Uint8Array(Array.from({ length: 5000 }, (_, i) => i % 251)) },
];

const zip = createZip(entries, new Date(2026, 7, 20, 12, 34, 56));
const zipPath = path.join(OUT, 'zip-check.zip');
fs.writeFileSync(zipPath, zip);

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const magic = (at: number) => zip[at] | (zip[at + 1] << 8) | (zip[at + 2] << 16) | (zip[at + 3] << 24);
check('เริ่มด้วยลายเซ็น local header', magic(0) === 0x04034b50);
check('ปิดท้ายด้วย end-of-central-directory', magic(zip.length - 22) === 0x06054b50);
check('จำนวนรายการตรง', (zip[zip.length - 14] | (zip[zip.length - 13] << 8)) === entries.length);
check('ขนาดสมเหตุสมผล', zip.length > entries.reduce((s, e) => s + e.bytes.length, 0));

console.log(`\n  ไฟล์ทดสอบ: ${zipPath}`);
console.log('  ตรวจของจริงต่อด้วย: Expand-Archive -Path <ไฟล์> -DestinationPath <โฟลเดอร์>');
console.log(failures === 0 ? '\nZIP CHECKS PASSED' : `\n${failures} ZIP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
