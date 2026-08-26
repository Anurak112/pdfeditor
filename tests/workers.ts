/**
 * The two workers must open documents the same way.
 *
 * Node cannot run either of them — both need OffscreenCanvas and a Worker — so
 * what is checked here is the thing that actually went wrong: the two workers
 * each carried their own copy of the options, one correction was applied to
 * both by hand, and a second correction was missing from both. Neither the type
 * checker nor any test noticed, because both files were individually valid.
 *
 * What only a browser can check, and what was checked by hand in the production
 * build (not the dev server, which is where this hid):
 *
 *   the invoiceWithLogo fixture → JPG    — the document that crashed. Its logo
 *     drives pdf.js to ask for a scratch canvas, and the default factory does
 *     globalThis.document.createElement, which in a worker is undefined.
 *   a Thai-language manual → thumbs and one full page — the render worker's
 *     two jobs, Thai glyphs intact.
 *
 * Re-run those two by hand after touching anything in this area. A green run
 * here means the wiring is shared; it does not mean the pixels came out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workerDocumentOptions } from '../src/lib/pdf/workerDocument';

const WORKERS = ['pdf.worker.ts', 'render.worker.ts'];

export async function runWorkerChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  console.log('\n=== การเปิดเอกสารในเวิร์กเกอร์ ===');

  const options = workerDocumentOptions(new Uint8Array([1, 2, 3]));

  check('ปิด document.fonts ที่เวิร์กเกอร์ไม่มี', options.disableFontFace === true);
  check('ส่งโรงงานผ้าใบที่ไม่ต้องใช้ document ไปด้วย',
    typeof options.CanvasFactory === 'function',
    typeof options.CanvasFactory);
  check('คัดลอกไบต์ให้ pdf.js ไม่ใช่ยื่นบัฟเฟอร์เดิม', options.data instanceof Uint8Array);

  // The factory itself, as far as Node can go: it must not reach for a document.
  {
    const Factory = options.CanvasFactory as new (o: Record<string, unknown>) => {
      create(w: number, h: number): unknown;
    };
    const factory = new Factory({});
    let reachedForDocument = false;
    try {
      factory.create(4, 4);
    } catch (e) {
      // Node has no OffscreenCanvas, so a throw is expected. What must not
      // appear is the error the DOM factory gives: reading 'createElement'.
      reachedForDocument = /createElement/.test(String((e as Error).message));
    }
    check('โรงงานผ้าใบไม่ไปแตะ document', !reachedForDocument);
  }

  // Neither worker may open a document its own way again.
  for (const name of WORKERS) {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'platform', 'worker', name),
      'utf-8',
    );
    const opens = [...source.matchAll(/getDocument\(/g)].length;
    const shared = [...source.matchAll(/getDocument\(workerDocumentOptions\(/g)].length;
    check(`${name}: เปิดเอกสารผ่านทางเดียวกันทุกที่`, opens > 0 && opens === shared,
      `${shared} จาก ${opens} จุด`);
  }

  return failures;
}
