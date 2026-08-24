/**
 * Where the UI looks up any tool's option shape.
 *
 * Each built tool keeps its options next to its operation, in the engine —
 * that is the only way the panel, the prediction line and the processor stay
 * agreed on the field names. This file re-exports them so a panel has one
 * import to reach for, and holds the shapes for tools that have no engine yet.
 */
import { appError } from '../engine/errors';
import type { OptionsValidator } from './types';

// --- built, and living with their operations --------------------------------

export type { MergeOptions } from '../engine/operations/merge';
export { MERGE_DEFAULTS } from '../engine/operations/merge';

export type { SplitOptions, SplitMode } from '../engine/operations/split';
export { SPLIT_DEFAULTS } from '../engine/operations/split';

export type { ConvertOptions, ConvertTarget } from '../engine/operations/convert';
export { CONVERT_DEFAULTS } from '../engine/operations/convert';

export type { EditOptions } from '../engine/operations/edit';
export { EDIT_DEFAULTS } from '../engine/operations/edit';

export type { OrganizeOptions } from '../engine/operations/organize';
export { ORGANIZE_DEFAULTS } from '../engine/operations/organize';

export type { CompressOptions, CompressLevel } from '../engine/operations/compress';
export { COMPRESS_DEFAULTS, COMPRESS_PRESETS } from '../engine/operations/compress';

export type { UnlockOptions } from '../engine/operations/unlock';
export { UNLOCK_DEFAULTS } from '../engine/operations/unlock';

/**
 * Shallow-merges whatever the panel produced over the defaults.
 *
 * Deliberately permissive: no panel can produce an out-of-range value, and a
 * validator that pretends to check fields it does not understand is worse than
 * one that says plainly it only fills defaults.
 */
export function withDefaults<O extends object>(defaults: O): OptionsValidator<O> {
  return (raw: unknown) => {
    if (raw == null) return { ok: true, value: { ...defaults } };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        error: appError('E_BAD_OPTIONS', { detail: 'options must be an object, got ' + typeof raw }),
      };
    }
    return { ok: true, value: { ...defaults, ...(raw as Partial<O>) } };
  };
}
