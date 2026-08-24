/**
 * Everything the engine can do, by id.
 *
 * Replaces the switch in the worker, which was going to grow one case per tool
 * and one import per tool at the top. Registering here means the worker never
 * changes again as tools are added, and a Node test can run any operation
 * without touching worker plumbing at all.
 */
import { editOperation } from './edit';
import { mergeOperation } from './merge';
import { organizeOperation } from './organize';
import { splitOperation } from './split';
import { convertOperation } from './convert';
import { compressOperation } from './compress';
import { unlockOperation } from './unlock';
import type { OperationId, PdfOperation } from '../types';

/**
 * Operations have different option shapes, so the registry stores them widened.
 * Narrowing happens at the edge, where the tool that owns the options validates
 * them before the job is ever created.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = PdfOperation<any>;

const REGISTERED: AnyOperation[] = [
  mergeOperation,
  editOperation,
  organizeOperation,
  splitOperation,
  convertOperation,
  compressOperation,
  unlockOperation,
];

const BY_ID = new Map<OperationId, AnyOperation>(REGISTERED.map((op) => [op.id, op]));

export function getOperation(id: OperationId | string): AnyOperation | null {
  return BY_ID.get(id as OperationId) ?? null;
}

/** Which operations actually have an engine behind them right now. */
export function implementedOperations(): OperationId[] {
  return [...BY_ID.keys()];
}

export {
  mergeOperation,
  editOperation,
  organizeOperation,
  splitOperation,
  convertOperation,
  compressOperation,
  unlockOperation,
};
export type { MergeOptions } from './merge';
export { MERGE_DEFAULTS } from './merge';
export type { EditOptions } from './edit';
export { EDIT_DEFAULTS } from './edit';
export type { OrganizeOptions } from './organize';
export { ORGANIZE_DEFAULTS } from './organize';
export type { SplitOptions, SplitMode } from './split';
export { SPLIT_DEFAULTS } from './split';
export type { ConvertOptions, ConvertTarget } from './convert';
export { CONVERT_DEFAULTS } from './convert';
export type { CompressOptions, CompressLevel } from './compress';
export { COMPRESS_DEFAULTS, COMPRESS_PRESETS } from './compress';
export type { UnlockOptions } from './unlock';
export { UNLOCK_DEFAULTS } from './unlock';
