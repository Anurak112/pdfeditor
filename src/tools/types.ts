/**
 * The contract every PDF tool implements.
 *
 * A tool does not know whether it runs in this tab, in a worker, or on a
 * server — `lane` is metadata for the UI, not a branch inside the tool. That is
 * what makes it possible to move Compress onto a server later without the
 * workspace screen changing at all.
 */
import type { Component } from 'svelte';
import type { AppError } from '../engine/errors';

export type ToolId = 'merge' | 'split' | 'compress' | 'convert' | 'edit' | 'organize' | 'unlock';

/** Where the work happens, and how honest we have to be about the result. */
export type Lane =
  /** Runs fully on the user's machine, no caveats. */
  | 'client'
  /** Runs here, but the result is weaker than a server's — the UI must say so. */
  | 'limited'
  /** Cannot be done honestly in a browser at all. */
  | 'server';

export type ToolCategory = 'organize' | 'optimize' | 'convert' | 'edit' | 'security';

/** Whether the engine behind the tool exists yet. The shell ships first. */
export type ToolStatus = 'ready' | 'planned';

export type Locale = 'th' | 'en';

export interface LocalizedString {
  th: string;
  en: string;
}

/** A file after we have actually opened it — every field here is measured, not guessed. */
export interface LoadedFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  sizeBytes: number;
  pageCount: number;
  isEncrypted: boolean;
  /** False for scans. Decides whether Edit and PDF-to-text can work at all. */
  hasTextLayer: boolean;
  /** PDF user space, per page. Mixed sizes change how Merge has to behave. */
  pageSizes: { w: number; h: number }[];
}

export interface ToolInput {
  files: LoadedFile[];
  options: unknown;
}

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface RunStats {
  originalBytes?: number;
  outputBytes?: number;
  savedPercent?: number;
  pagesProcessed?: number;
  replacements?: number;
}

export interface ToolOutput {
  files: OutputFile[];
  stats?: RunStats;
  /** The run succeeded, but something is worth telling the user. */
  warnings?: AppError[];
}

export interface RunContext {
  /** Percent must come from work actually finished, never from a timer. */
  onProgress(p: { percent: number; message: LocalizedString }): void;
  /** Cancelling has to stop the work, not just hide the panel. */
  signal: AbortSignal;
  locale: Locale;
}

/**
 * Options arrive from the UI as unknown and are validated here, so a tool never
 * has to defend itself against its own option panel.
 */
export type OptionsValidator<O> = (raw: unknown) => { ok: true; value: O } | { ok: false; error: AppError };

export interface ToolDefinition<O = Record<string, unknown>> {
  id: ToolId;
  name: LocalizedString;
  blurb: LocalizedString;
  /** Inline SVG path data — no icon font, no network request. */
  icon: string;
  category: ToolCategory;
  lane: Lane;
  status: ToolStatus;

  minFiles: number;
  maxFiles: number;
  acceptedInputs: string[];
  outputTypes: string[];

  defaultOptions: O;
  validateOptions: OptionsValidator<O>;

  ui: {
    needsPageGrid: boolean;
    /**
     * What the grid is for in this tool. 'select' picks pages; 'organize' also
     * rotates, deletes and rearranges them. Declared here rather than checked
     * by tool id in the workspace, so a new tool never means a new branch.
     */
    pageGridMode?: 'select' | 'organize';
    supportsBatch: boolean;
    /**
     * The settings panel for this tool, rendered into the workspace column.
     * Absent while a tool has no panel yet — the workspace shows a placeholder.
     */
    optionsComponent?: Component;
  };

  /**
   * The line above the button: "you will get 3 files, about 240 KB".
   * Users should never have to press a button to find out what it does.
   */
  predict?(files: LoadedFile[], options: O): LocalizedString | null;

  run(input: ToolInput, ctx: RunContext): Promise<ToolOutput>;
}

/** The registry holds tools with different option shapes, so it stores this. */
export type AnyTool = ToolDefinition<any>;
