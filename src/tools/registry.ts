/**
 * The list of tools the product offers.
 *
 * This is the only place a tool is declared. The home grid, the workspace
 * header, the accepted file types, the lane badge and the "not built yet"
 * message all read from here, so adding a tool means adding one entry — never
 * touching routing or layout.
 *
 * `status` is honest on purpose: the shell ships before the engines, and a card
 * that looks ready but throws is worse than one that says it is coming.
 */
import EditOptionsPanel from '../platform/components/options/EditOptions.svelte';
import CompressOptionsPanel from '../platform/components/options/CompressOptions.svelte';
import ConvertOptionsPanel from '../platform/components/options/ConvertOptions.svelte';
import MergeOptionsPanel from '../platform/components/options/MergeOptions.svelte';
import OrganizeOptionsPanel from '../platform/components/options/OrganizeOptions.svelte';
import SplitOptionsPanel from '../platform/components/options/SplitOptions.svelte';
import UnlockOptionsPanel from '../platform/components/options/UnlockOptions.svelte';
import { runInWorker } from '../platform/worker/client';
import { finalOrder as organizeFinalOrder } from '../engine/operations/organize';
import { splitPlan } from '../engine/operations/split';
import { directionOf, targetsFor } from '../engine/operations/convert';
import {
  COMPRESS_DEFAULTS,
  CONVERT_DEFAULTS,
  EDIT_DEFAULTS,
  MERGE_DEFAULTS,
  ORGANIZE_DEFAULTS,
  SPLIT_DEFAULTS,
  UNLOCK_DEFAULTS,
  withDefaults,
} from './options';
import { parseRanges } from '../engine/ranges';
export { parseRanges } from '../engine/ranges';
import type { AnyTool, LoadedFile, ToolDefinition, ToolId } from './types';
import type {
  CompressOptions,
  ConvertOptions,
  EditOptions,
  MergeOptions,
  OrganizeOptions,
  SplitOptions,
  UnlockOptions,
} from './options';

const PDF = 'application/pdf';
const IMAGES = ['image/jpeg', 'image/png'];

/** Stroke paths on a 24x24 box, so one <svg> component can draw them all. */
const ICONS = {
  merge: 'M4 4h6v5H4zM4 15h6v5H4zM14 9.5h6v5h-6zM10 6.5h1.5a2.5 2.5 0 0 1 2.5 2.5M10 17.5h1.5a2.5 2.5 0 0 0 2.5-2.5',
  split: 'M6 3h8l4 4v14H6zM14 3v4h4M3 12h18',
  compress: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M8 12h8',
  convert: 'M4 8.5h13l-3.5-3.5M20 15.5H7l3.5 3.5',
  edit: 'M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5zM14.5 6.5l3 3',
  organize: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-1.8M5 11h14v10H5z',
} as const;

function totalPages(files: LoadedFile[]): number {
  return files.reduce((n, f) => n + f.pageCount, 0);
}

function approxBytes(files: LoadedFile[], pages: number): number {
  const all = totalPages(files);
  if (all === 0) return 0;
  const bytes = files.reduce((n, f) => n + f.sizeBytes, 0);
  return Math.round((bytes / all) * pages);
}

function kb(n: number): string {
  return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
}

const merge: ToolDefinition<MergeOptions> = {
  id: 'merge',
  name: { th: 'รวมไฟล์', en: 'Merge' },
  blurb: { th: 'รวมหลาย PDF เป็นไฟล์เดียว', en: 'Combine several PDFs into one file' },
  icon: ICONS.merge,
  category: 'organize',
  lane: 'client',
  status: 'ready',
  minFiles: 2,
  maxFiles: 20,
  acceptedInputs: [PDF],
  outputTypes: [PDF],
  defaultOptions: MERGE_DEFAULTS,
  validateOptions: withDefaults(MERGE_DEFAULTS),
  ui: { needsPageGrid: false, supportsBatch: false, optionsComponent: MergeOptionsPanel },
  predict(files) {
    if (files.length < 2) return null;
    const pages = totalPages(files);
    const size = files.reduce((n, f) => n + f.sizeBytes, 0);
    return {
      th: `จะได้ 1 ไฟล์ · ${pages} หน้า · ประมาณ ${kb(size)}`,
      en: `You will get 1 file, ${pages} pages, about ${kb(size)}`,
    };
  },
  async run(input, ctx) {
    const outcome = await runInWorker('merge', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

const split: ToolDefinition<SplitOptions> = {
  id: 'split',
  name: { th: 'แยกหน้า', en: 'Split' },
  blurb: { th: 'ดึงหน้าที่ต้องการ หรือตัดเอกสารเป็นหลายไฟล์', en: 'Pull out the pages you need, or cut it into files' },
  icon: ICONS.split,
  category: 'organize',
  lane: 'client',
  status: 'ready',
  minFiles: 1,
  maxFiles: 1,
  acceptedInputs: [PDF],
  outputTypes: [PDF, 'application/zip'],
  defaultOptions: SPLIT_DEFAULTS,
  validateOptions: withDefaults(SPLIT_DEFAULTS),
  ui: { needsPageGrid: true, supportsBatch: false, optionsComponent: SplitOptionsPanel },
  predict(files, o) {
    const file = files[0];
    if (!file) return null;
    const plan = splitPlan(file.pageCount, o);
    if (plan.groups.length === 0) {
      return o.mode === 'ranges'
        ? { th: 'ยังไม่ได้ระบุช่วงที่ใช้ได้', en: 'No usable ranges yet' }
        : { th: 'ยังไม่ได้เลือกหน้า', en: 'No pages selected yet' };
    }

    const pages = plan.groups.reduce((n, g) => n + g.length, 0);
    const zipped = plan.groups.length > 1 && o.zipWhenMultiple;
    const approx = Math.round((file.sizeBytes / Math.max(1, file.pageCount)) * pages);
    const size = approx < 1024 * 1024
      ? Math.max(1, Math.round(approx / 1024)) + ' KB'
      : (approx / 1024 / 1024).toFixed(1) + ' MB';

    return {
      th: `จะได้ ${plan.groups.length} ไฟล์${zipped ? ' (ห่อ ZIP)' : ''} · ${pages} หน้า · ประมาณ ${size}`,
      en: `You will get ${plan.groups.length} file${plan.groups.length > 1 ? 's' : ''}` +
        `${zipped ? ' (as a ZIP)' : ''}, ${pages} pages, about ${size}`,
    };
  },
  async run(input, ctx) {
    const outcome = await runInWorker('split', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

const compress: ToolDefinition<CompressOptions> = {
  id: 'compress',
  name: { th: 'ลดขนาด', en: 'Compress' },
  blurb: {
    th: 'บีบภาพในไฟล์ให้เล็กลง โดยข้อความยังคมและยังค้นหาได้',
    en: 'Squeeze the images down while the text stays sharp and searchable',
  },
  icon: ICONS.compress,
  category: 'optimize',
  lane: 'client',
  status: 'ready',
  minFiles: 1,
  maxFiles: 20,
  acceptedInputs: [PDF],
  outputTypes: [PDF, 'application/zip'],
  defaultOptions: COMPRESS_DEFAULTS,
  validateOptions: withDefaults(COMPRESS_DEFAULTS),
  ui: { needsPageGrid: false, supportsBatch: true, optionsComponent: CompressOptionsPanel },
  // No predicted percentage. Whether a file will shrink is a property of what
  // is inside it, and finding that out means walking every image stream — too
  // slow for the main thread and, guessed at instead, a number that would be
  // wrong exactly on the documents people care most about.
  predict(files) {
    if (files.length === 0) return null;
    const size = kb(files.reduce((n, f) => n + f.sizeBytes, 0));
    return {
      th: `ไฟล์รวม ${size} · จะลดได้เท่าไรขึ้นกับว่ามีภาพอยู่ในไฟล์มากแค่ไหน`,
      en: `${size} in total — how much comes off depends on how much of it is images`,
    };
  },
  async run(input, ctx) {
    const outcome = await runInWorker('compress', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

const convert: ToolDefinition<ConvertOptions> = {
  id: 'convert',
  name: { th: 'แปลงไฟล์', en: 'Convert' },
  blurb: { th: 'PDF เป็น JPG PNG ข้อความ · และภาพกลับเป็น PDF', en: 'PDF to JPG, PNG or text — and images back to PDF' },
  icon: ICONS.convert,
  category: 'convert',
  lane: 'client',
  status: 'ready',
  minFiles: 1,
  maxFiles: 20,
  acceptedInputs: [PDF, ...IMAGES],
  outputTypes: [PDF, 'image/jpeg', 'image/png', 'text/plain', 'application/zip'],
  defaultOptions: CONVERT_DEFAULTS,
  validateOptions: withDefaults(CONVERT_DEFAULTS),
  ui: { needsPageGrid: false, supportsBatch: true, optionsComponent: ConvertOptionsPanel },
  predict(files, o) {
    const direction = directionOf(files);
    if (direction === null) return null;
    if (!targetsFor(direction).includes(o.to)) return null;

    if (direction === 'pdf-out') {
      return {
        th: `จะได้ 1 ไฟล์ PDF · ${files.length} หน้า`,
        en: `You will get 1 PDF, ${files.length} pages`,
      };
    }
    if (o.to === 'txt') {
      return {
        th: `จะได้ ${files.length} ไฟล์ข้อความ`,
        en: `You will get ${files.length} text file${files.length > 1 ? 's' : ''}`,
      };
    }

    const pages = files.reduce((n, f) => n + f.pageCount, 0);
    const zipped = pages > 1 && o.zipWhenMultiple;
    return {
      th: `จะได้ ${pages} ภาพ ${o.to.toUpperCase()}${zipped ? ' (ห่อ ZIP)' : ''} · ${o.dpi} dpi`,
      en: `You will get ${pages} ${o.to.toUpperCase()} image${pages > 1 ? 's' : ''}` +
        `${zipped ? ' (as a ZIP)' : ''} at ${o.dpi} dpi`,
    };
  },
  async run(input, ctx) {
    const outcome = await runInWorker('convert', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

const edit: ToolDefinition<EditOptions> = {
  id: 'edit',
  name: { th: 'แก้ข้อความ', en: 'Edit text' },
  blurb: {
    th: 'ค้นหาและแทนที่ข้อความในไฟล์จริง ไม่ใช่ปะกล่องทับ',
    en: 'Find and replace real text in the file, not a patch over it',
  },
  icon: ICONS.edit,
  category: 'edit',
  lane: 'client',
  status: 'ready',
  minFiles: 1,
  maxFiles: 20,
  acceptedInputs: [PDF],
  outputTypes: [PDF, 'application/zip'],
  defaultOptions: EDIT_DEFAULTS,
  validateOptions: withDefaults(EDIT_DEFAULTS),
  // The grid earns its place here: seeing which page a match is on is most of
  // the reason to look before replacing.
  ui: { needsPageGrid: true, supportsBatch: true, optionsComponent: EditOptionsPanel },
  predict(files, o) {
    if (!o.find) return { th: 'ใส่ข้อความที่จะค้นหาก่อน', en: 'Type the text to look for' };
    if (files.length > 1) {
      return {
        th: `จะค้นหา "${o.find}" ใน ${files.length} ไฟล์ · ผลลัพธ์ห่อ ZIP`,
        en: `Will look for "${o.find}" across ${files.length} files, returned as a ZIP`,
      };
    }
    return null;
  },
  async run(input, ctx) {
    const outcome = await runInWorker('edit', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

const organize: ToolDefinition<OrganizeOptions> = {
  id: 'organize',
  name: { th: 'จัดหน้า', en: 'Organize' },
  blurb: { th: 'หมุน ลบ และเรียงหน้าใหม่', en: 'Rotate, delete and reorder pages' },
  icon: ICONS.organize,
  category: 'organize',
  lane: 'client',
  status: 'ready',
  minFiles: 1,
  maxFiles: 1,
  acceptedInputs: [PDF],
  outputTypes: [PDF],
  defaultOptions: ORGANIZE_DEFAULTS,
  validateOptions: withDefaults(ORGANIZE_DEFAULTS),
  ui: {
    needsPageGrid: true,
    pageGridMode: 'organize',
    supportsBatch: false,
    optionsComponent: OrganizeOptionsPanel,
  },
  predict(files, o) {
    const file = files[0];
    if (!file) return null;
    const kept = organizeFinalOrder(file.pageCount, o).length;
    if (kept === 0) return { th: 'ลบหมดทุกหน้าแล้ว', en: 'Every page is deleted' };
    return {
      th: `จะได้ 1 ไฟล์ · ${kept} หน้า`,
      en: `You will get 1 file, ${kept} pages`,
    };
  },
  async run(input, ctx) {
    const outcome = await runInWorker('organize', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

const unlock: ToolDefinition<UnlockOptions> = {
  id: 'unlock',
  name: { th: 'ปลดล็อกรหัสผ่าน', en: 'Unlock' },
  blurb: {
    th: 'เอารหัสผ่านออก เมื่อคุณรู้รหัสอยู่แล้ว',
    en: 'Remove the password from a file whose password you know',
  },
  icon: ICONS.unlock,
  category: 'security',
  lane: 'client',
  status: 'ready',
  minFiles: 1,
  maxFiles: 1,
  acceptedInputs: [PDF],
  outputTypes: [PDF],
  defaultOptions: UNLOCK_DEFAULTS,
  validateOptions: withDefaults(UNLOCK_DEFAULTS),
  ui: { needsPageGrid: false, supportsBatch: false, optionsComponent: UnlockOptionsPanel },
  predict(files) {
    const file = files[0];
    if (!file) return null;
    // The loader already tried to open it, so this is known rather than guessed.
    return file.isEncrypted
      ? { th: 'ไฟล์นี้ใส่รหัสไว้ — ใส่รหัสแล้วกดเริ่ม', en: 'This file is protected — enter the password and start' }
      : {
          th: 'ไฟล์นี้เปิดได้อยู่แล้ว — ถ้าสั่งพิมพ์หรือก๊อปไม่ได้ ให้กดเริ่มโดยไม่ต้องใส่รหัส',
          en: 'This one already opens — if it will not print or copy, start without a password',
        };
  },
  async run(input, ctx) {
    const outcome = await runInWorker('unlock', input.files, input.options, {
      onProgress: (percent, message) => ctx.onProgress({ percent, message }),
      signal: ctx.signal,
    });
    return { files: outcome.result.files, stats: outcome.result.stats, warnings: outcome.warnings };
  },
};

/** Home-grid order: the four the spec asked for, then ours, then the security one. */
export const TOOLS: AnyTool[] = [merge, compress, convert, split, edit, organize, unlock];

const BY_ID = new Map<ToolId, AnyTool>(TOOLS.map((t) => [t.id, t]));

export function getTool(id: string | null | undefined): AnyTool | null {
  return id ? BY_ID.get(id as ToolId) ?? null : null;
}

/** Tools that can do something with the files already loaded. */
export function toolsAccepting(mimeTypes: string[]): AnyTool[] {
  if (mimeTypes.length === 0) return TOOLS;
  return TOOLS.filter((t) => mimeTypes.every((m) => t.acceptedInputs.includes(m)));
}
