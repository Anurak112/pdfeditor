/**
 * Convert — five adapters, not one generic converter.
 *
 * "PDF to anything" as a single engine is the trap the reference spec warned
 * about, and it is right: each direction has its own failure mode, its own
 * quality knob and its own honest limit. PDF to JPG loses text; PDF to text
 * loses layout; images to PDF is nearly lossless; and DOCX in either direction
 * cannot be done honestly in a browser at all, which is why it is absent here
 * rather than half-present.
 */
import { PDFDocument } from 'pdf-lib';
import { appError, appWarning } from '../errors';
import { asPdfName, fillPattern, sanitiseFilename, stem } from '../naming';
import { readAllPages } from '../../lib/editor/replaceJob';
import { textOfPages } from '../text';
import { sniff } from '../sniff';
import { createZip } from '../../lib/utils/zip';
import { span } from '../types';
import type { JobFile, OperationContext, OperationResult, OutputFile, PdfOperation } from '../types';

export type ConvertTarget = 'jpg' | 'png' | 'txt' | 'pdf';

export interface ConvertOptions {
  to: ConvertTarget;
  /** Raster resolution. 150 reads well on screen; 300 is for printing or OCR. */
  dpi: 72 | 150 | 300;
  /** JPEG only. */
  quality: number;
  /** PNG only — keeps the page background out. */
  transparent: boolean;
  textFlow: 'keep-lines' | 'paragraphs';
  pageSeparator: boolean;
  /** Images to PDF. */
  imagePageSize: 'fit-image' | 'a4' | 'letter';
  imageMarginMm: number;
  zipWhenMultiple: boolean;
}

export const CONVERT_DEFAULTS: ConvertOptions = {
  to: 'jpg',
  dpi: 150,
  quality: 0.85,
  transparent: false,
  textFlow: 'keep-lines',
  pageSeparator: true,
  imagePageSize: 'fit-image',
  imageMarginMm: 0,
  zipWhenMultiple: true,
};

const A4: [number, number] = [595.28, 841.89];
const LETTER: [number, number] = [612, 792];
const MM = 72 / 25.4;

/** Which way a job is going, decided by the bytes rather than the extensions. */
export type Direction = 'pdf-out' | 'pdf-in';

export function directionOf(files: { bytes: Uint8Array }[]): Direction | null {
  if (files.length === 0) return null;
  const kinds = new Set(files.map((f) => sniff(f.bytes)));
  if (kinds.size === 1 && kinds.has('pdf')) return 'pdf-in';
  if (!kinds.has('pdf') && !kinds.has('unknown')) return 'pdf-out';
  return null;
}

/** Targets that make sense for what was loaded. */
export function targetsFor(direction: Direction | null): ConvertTarget[] {
  if (direction === 'pdf-in') return ['jpg', 'png', 'txt'];
  if (direction === 'pdf-out') return ['pdf'];
  return [];
}

/** Above this many raster pages the output gets unwieldy and worth mentioning. */
const MANY_IMAGES = 60;

async function rasterise(
  files: JobFile[],
  options: ConvertOptions,
  ctx: OperationContext,
): Promise<OutputFile[]> {
  const openPdfjs = ctx.openPdfjs;
  if (!openPdfjs) {
    throw appError('E_INTERNAL', { detail: 'rasterising needs pdf.js and this host did not supply it' });
  }
  if (typeof OffscreenCanvas === 'undefined') {
    throw appError('E_INTERNAL', { detail: 'rasterising needs OffscreenCanvas and this host has none' });
  }

  const type = options.to === 'png' ? 'image/png' : 'image/jpeg';
  const extension = options.to === 'png' ? 'png' : 'jpg';
  const scale = options.dpi / 72;
  const outputs: OutputFile[] = [];

  // Counted up front so the progress bar means something across several files.
  let totalPages = 0;
  const handles = [];
  for (const file of files) {
    const handle = await openPdfjs(file.bytes);
    handles.push({ file, handle });
    totalPages += (handle.doc as unknown as { numPages: number }).numPages;
  }

  if (totalPages > MANY_IMAGES) {
    ctx.warn(
      appWarning('W_MANY_OUTPUTS', {
        hint: {
          th: `จะได้ ${totalPages} ภาพ — ที่ ${options.dpi} dpi ไฟล์รวมจะใหญ่พอสมควร`,
          en: `That is ${totalPages} images — at ${options.dpi} dpi the total gets large`,
        },
      }),
    );
  }
  if (options.to === 'png') {
    ctx.warn(appWarning('W_PNG_LARGER'));
  }

  const at = span(5, 92);
  let done = 0;

  try {
    for (const { file, handle } of handles) {
      const doc = handle.doc as unknown as {
        numPages: number;
        getPage(n: number): Promise<{
          getViewport(o: { scale: number }): { width: number; height: number };
          render(o: unknown): { promise: Promise<void> };
          cleanup(): void;
        }>;
      };
      const base = sanitiseFilename(stem(file.name));

      for (let n = 1; n <= doc.numPages; n++) {
        ctx.throwIfAborted();
        ctx.onProgress(at(done, totalPages), {
          th: `กำลังแปลงหน้า ${n} ของ ${file.name}`,
          en: `Rendering page ${n} of ${file.name}`,
        });

        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale });
        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw appError('E_INTERNAL', { detail: 'OffscreenCanvas gave no 2d context' });

        // JPEG has no transparency, so a page drawn without a background comes
        // out black. PNG can keep it, if that is what was asked for.
        if (!(options.to === 'png' && options.transparent)) {
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
        }

        await page.render({ canvas, canvasContext: context, viewport } as never).promise;
        page.cleanup();

        const blob = await canvas.convertToBlob(
          options.to === 'png' ? { type } : { type, quality: options.quality },
        );
        outputs.push({
          name:
            doc.numPages === 1 && files.length === 1
              ? `${base}.${extension}`
              : fillPattern(`<name>-<nn>.${extension}`, { name: base, n, total: doc.numPages }),
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mimeType: type,
        });
        done++;
      }
    }
  } finally {
    for (const { handle } of handles) handle.close();
  }

  return outputs;
}

async function toText(files: JobFile[], options: ConvertOptions, ctx: OperationContext): Promise<OutputFile[]> {
  const openPdfjs = ctx.openPdfjs;
  if (!openPdfjs) {
    throw appError('E_INTERNAL', { detail: 'reading text needs pdf.js and this host did not supply it' });
  }

  const at = span(5, 92);
  const outputs: OutputFile[] = [];
  const empty: string[] = [];

  for (let i = 0; i < files.length; i++) {
    ctx.throwIfAborted();
    const file = files[i];
    ctx.onProgress(at(i, files.length), {
      th: `กำลังอ่านข้อความจาก ${file.name}`,
      en: `Reading text from ${file.name}`,
    });

    const handle = await openPdfjs(file.bytes);
    try {
      const pages = await readAllPages(handle.doc);
      const text = textOfPages(pages, { flow: options.textFlow, pageSeparator: options.pageSeparator });

      if (text.trim().length === 0) {
        empty.push(file.name);
        continue;
      }

      outputs.push({
        name: sanitiseFilename(stem(file.name)) + '.txt',
        // A BOM so Windows Notepad opens Thai as Thai rather than as mojibake.
        bytes: new TextEncoder().encode('﻿' + text),
        mimeType: 'text/plain',
      });
    } finally {
      handle.close();
    }
  }

  if (outputs.length === 0) {
    throw appError('E_NO_TEXT_LAYER', {
      hint: {
        th: 'เอกสารนี้เป็นภาพสแกน — ไม่มีชั้นข้อความให้ดึงออกมา',
        en: 'These are scans, so there is no text layer to pull out',
      },
    });
  }
  if (empty.length > 0) {
    ctx.warn(
      appWarning('W_NO_TEXT_IN_FILE', {
        hint: {
          th: `ไม่มีข้อความใน: ${empty.join(', ')}`,
          en: `No text layer in: ${empty.join(', ')}`,
        },
      }),
    );
  }

  return outputs;
}

async function imagesToPdf(
  files: JobFile[],
  options: ConvertOptions,
  ctx: OperationContext,
): Promise<OutputFile[]> {
  const pdf = await PDFDocument.create();
  const at = span(5, 90);
  const margin = Math.max(0, options.imageMarginMm) * MM;

  for (let i = 0; i < files.length; i++) {
    ctx.throwIfAborted();
    const file = files[i];
    ctx.onProgress(at(i, files.length), {
      th: `กำลังวาง ${file.name}`,
      en: `Placing ${file.name}`,
    });

    const kind = sniff(file.bytes);
    const image =
      kind === 'png' ? await pdf.embedPng(file.bytes) : await pdf.embedJpg(file.bytes);

    if (options.imagePageSize === 'fit-image') {
      // The page becomes the picture: no letterboxing, no cropping, and the
      // result prints at the size the image actually is.
      const page = pdf.addPage([image.width + margin * 2, image.height + margin * 2]);
      page.drawImage(image, { x: margin, y: margin, width: image.width, height: image.height });
      continue;
    }

    const [pw, ph] = options.imagePageSize === 'a4' ? A4 : LETTER;
    const page = pdf.addPage([pw, ph]);
    const room = { w: pw - margin * 2, h: ph - margin * 2 };
    const scale = Math.min(room.w / image.width, room.h / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }

  pdf.setProducer('Simple PDF');
  pdf.setCreator('Simple PDF');

  ctx.onProgress(94, { th: 'กำลังเขียนไฟล์', en: 'Writing the file' });
  const name = asPdfName(sanitiseFilename(stem(files[0].name)) + (files.length > 1 ? '-รวมภาพ' : ''));
  return [{ name, bytes: await pdf.save(), mimeType: 'application/pdf' }];
}

async function run(files: JobFile[], options: ConvertOptions, ctx: OperationContext): Promise<OperationResult> {
  const direction = directionOf(files);
  if (direction === null) {
    throw appError('E_UNSUPPORTED_CONVERSION', {
      hint: {
        th: 'เลือก PDF อย่างเดียว หรือภาพอย่างเดียว — ปนกันแล้วไม่รู้ว่าจะแปลงไปทางไหน',
        en: 'Choose PDFs or images, not both — mixed, there is no telling which way you meant',
      },
    });
  }
  if (!targetsFor(direction).includes(options.to)) {
    throw appError('E_UNSUPPORTED_CONVERSION', {
      hint: {
        th: `แปลงจากสิ่งที่เลือกไปเป็น ${options.to.toUpperCase()} ไม่ได้`,
        en: `What you loaded cannot be turned into ${options.to.toUpperCase()}`,
      },
    });
  }

  const outputs =
    direction === 'pdf-out'
      ? await imagesToPdf(files, options, ctx)
      : options.to === 'txt'
        ? await toText(files, options, ctx)
        : await rasterise(files, options, ctx);

  const originalBytes = files.reduce((n, f) => n + f.bytes.byteLength, 0);

  if (outputs.length === 1 || !options.zipWhenMultiple) {
    return {
      files: outputs,
      stats: {
        originalBytes,
        outputBytes: outputs.reduce((n, o) => n + o.bytes.byteLength, 0),
        pagesProcessed: outputs.length,
      },
    };
  }

  ctx.onProgress(95, { th: 'กำลังห่อ ZIP', en: 'Packing the ZIP' });
  const zip = createZip(outputs.map((o) => ({ name: o.name, bytes: o.bytes })));
  const base = sanitiseFilename(stem(files[0].name));

  return {
    files: [{ name: `${base}-${options.to}.zip`, bytes: zip, mimeType: 'application/zip' }],
    stats: { originalBytes, outputBytes: zip.byteLength, pagesProcessed: outputs.length },
  };
}

export const convertOperation: PdfOperation<ConvertOptions> = { id: 'convert', run };
