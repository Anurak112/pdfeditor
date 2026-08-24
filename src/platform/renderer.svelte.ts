/**
 * One renderer per document, serving the grid and the viewer.
 *
 * Only what has been asked for is drawn. A 900-page document rasterised up
 * front is a minute of work for pictures nobody scrolled to, so the grid
 * reports which tiles are near the viewport and this fetches those.
 *
 * Viewer requests jump the queue. Thumbnails can wait a second; a page someone
 * is looking at cannot, and behind a full batch of thumbnails it would.
 *
 * Object URLs are revoked on dispose and on replacement. They are the easiest
 * thing in a browser to leak, and leaking one per page of a long document — or
 * one per zoom step — is how a tab that felt fine becomes unusable.
 */
import type { LoadedFile } from '../tools/types';
import type { FindRequest, PageRequest, RenderRequest, RenderResponse, ThumbsRequest } from './worker/render.worker';

export interface Thumb {
  index: number;
  /** null until it has been drawn. */
  url: string | null;
  /** Page size in PDF user space. */
  width: number;
  height: number;
  /** Rotation already baked into the document, not one the user added. */
  rotation: number;
}

export interface MatchCount {
  needle: string;
  total: number;
  /** 1-based page numbers containing at least one match. */
  pages: number[];
  /** True when the document has no text layer at all — a scan, most likely. */
  scanned: boolean;
}

export interface RenderedPage {
  index: number;
  url: string;
  /** Natural page size in PDF user space, for working out fit and aspect. */
  width: number;
  height: number;
}

/** Longest thumbnail edge in device pixels. Small enough to draw fast, sharp on a 2x screen. */
const THUMB_EDGE = 220;

/**
 * Small batches on purpose.
 *
 * The worker handles one message at a time, so a batch is also the longest a
 * viewer request can be stuck behind. Twenty-four thumbnails was about a third
 * of a second of waiting for a page turn.
 */
const THUMB_BATCH = 8;

export class PageRenderer {
  thumbs = $state<Thumb[]>([]);
  /** The page currently drawn for the viewer, or null before the first render. */
  page = $state<RenderedPage | null>(null);
  pageLoading = $state(false);
  /** Result of the last find, so a panel can say how many before anything runs. */
  matches = $state<MatchCount | null>(null);
  matchesLoading = $state(false);
  failed = $state<string | null>(null);

  readonly pageCount: number;

  private worker: Worker | null = null;
  private fileId: string;
  private bytes: Uint8Array;

  private requested = new Set<number>();
  private queue: number[] = [];
  private thumbsBusy = false;

  private pageToken = 0;
  private pendingPage: Omit<PageRequest, 'bytes'> | null = null;
  private pageBusy = false;

  private lastNeedle = '';
  private findToken = 0;
  private pendingFind: Omit<FindRequest, 'bytes'> | null = null;
  private findBusy = false;

  constructor(file: LoadedFile) {
    this.fileId = file.id;
    this.bytes = file.bytes;
    this.pageCount = file.pageCount;
    this.thumbs = Array.from({ length: file.pageCount }, (_, index) => ({
      index,
      url: null,
      width: file.pageSizes[index]?.w ?? 0,
      height: file.pageSizes[index]?.h ?? 0,
      rotation: 0,
    }));
  }

  // ---- thumbnails ---------------------------------------------------------

  /** Ask for these pages if they have not been asked for already. */
  want(indices: number[]) {
    const fresh = indices.filter((i) => !this.requested.has(i));
    if (fresh.length === 0) return;
    fresh.forEach((i) => this.requested.add(i));
    this.queue.push(...fresh);
    this.pump();
  }

  // ---- the viewer ---------------------------------------------------------

  /**
   * Draw one page at the given device-pixel width.
   *
   * Supersedes any earlier request: while a zoom control is being dragged only
   * the last value matters, and drawing the intermediate ones just makes the
   * last one arrive later.
   */
  showPage(index: number, targetWidth: number) {
    this.pendingPage = {
      jobId: this.fileId,
      kind: 'page',
      index,
      targetWidth: Math.max(64, Math.round(targetWidth)),
      token: ++this.pageToken,
    };
    this.pageLoading = true;
    this.pump();
  }

  /**
   * How many times this text appears, without running anything.
   *
   * The worker already has the document open and caches its text layer, so a
   * count costs one message rather than a second parse of the file. Superseded
   * the same way a zoom is: only the last keystroke matters.
   */
  countMatches(needle: string) {
    if (!needle) {
      this.pendingFind = null;
      this.matches = null;
      this.matchesLoading = false;
      return;
    }
    this.lastNeedle = needle;
    this.pendingFind = { jobId: this.fileId, kind: 'find', needle, token: ++this.findToken };
    this.matchesLoading = true;
    this.pump();
  }

  // ---- the one queue ------------------------------------------------------

  private pump() {
    if (this.pageBusy || this.thumbsBusy || this.findBusy) return;

    if (this.pendingFind) {
      const request: FindRequest = { ...this.pendingFind, bytes: new Uint8Array(this.bytes) };
      this.pendingFind = null;
      this.findBusy = true;
      this.ensureWorker().postMessage(request satisfies RenderRequest);
      return;
    }

    if (this.pendingPage) {
      const request: PageRequest = { ...this.pendingPage, bytes: new Uint8Array(this.bytes) };
      this.pendingPage = null;
      this.pageBusy = true;
      this.ensureWorker().postMessage(request satisfies RenderRequest);
      return;
    }

    if (this.queue.length === 0) return;
    const indices = this.queue.splice(0, THUMB_BATCH);
    this.thumbsBusy = true;
    const request: ThumbsRequest = {
      jobId: this.fileId,
      // A copy: transferring would detach the bytes the tools still need.
      bytes: new Uint8Array(this.bytes),
      kind: 'thumbs',
      indices,
      maxEdge: THUMB_EDGE,
    };
    this.ensureWorker().postMessage(request);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL('./worker/render.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      const msg = event.data;

      if (msg.kind === 'thumb') {
        const next = [...this.thumbs];
        const existing = next[msg.index];
        if (existing?.url) URL.revokeObjectURL(existing.url);
        next[msg.index] = {
          index: msg.index,
          url: URL.createObjectURL(msg.blob),
          width: msg.width,
          height: msg.height,
          rotation: msg.rotation,
        };
        this.thumbs = next;
        return;
      }

      if (msg.kind === 'page') {
        // A render a newer zoom has already superseded is dropped rather than
        // shown — otherwise the picture flickers back to the older scale.
        if (msg.token !== this.pageToken) {
          this.pageBusy = false;
          this.pump();
          return;
        }
        if (this.page?.url) URL.revokeObjectURL(this.page.url);
        this.page = {
          index: msg.index,
          url: URL.createObjectURL(msg.blob),
          width: msg.width,
          height: msg.height,
        };
        this.pageLoading = false;
        return;
      }

      if (msg.kind === 'found') {
        // A count a newer keystroke has already replaced is dropped, so the
        // number never flickers back to an older query's answer.
        if (msg.token !== this.findToken) {
          this.findBusy = false;
          this.pump();
          return;
        }
        this.matches = {
          needle: this.lastNeedle,
          total: msg.total,
          pages: msg.pages,
          scanned: msg.scanned,
        };
        this.matchesLoading = false;
        return;
      }

      if (msg.kind === 'error') {
        // The UI says "previews could not be drawn"; the reason belongs in the
        // console, where it is diagnosable instead of merely disappointing.
        console.warn('[render]', msg.of, msg.message);
        this.failed = msg.message;
        if (msg.of === 'page') {
          this.pageBusy = false;
          this.pageLoading = false;
        } else if (msg.of === 'find') {
          this.findBusy = false;
          this.matchesLoading = false;
        } else {
          this.thumbsBusy = false;
        }
        this.pump();
        return;
      }

      if (msg.of === 'page') this.pageBusy = false;
      else if (msg.of === 'find') this.findBusy = false;
      else this.thumbsBusy = false;
      this.pump();
    };

    worker.onerror = (event) => {
      console.warn('[render] worker', event.message, event.filename, event.lineno);
      this.failed = event.message || 'the render worker failed to start';
      this.thumbsBusy = false;
      this.pageBusy = false;
      this.findBusy = false;
      this.pageLoading = false;
      this.matchesLoading = false;
    };

    this.worker = worker;
    return worker;
  }

  dispose() {
    for (const t of this.thumbs) if (t.url) URL.revokeObjectURL(t.url);
    if (this.page?.url) URL.revokeObjectURL(this.page.url);
    this.thumbs = [];
    this.page = null;
    this.worker?.terminate();
    this.worker = null;
    this.requested.clear();
    this.queue = [];
    this.thumbsBusy = false;
    this.pageBusy = false;
    this.findBusy = false;
    this.pendingPage = null;
    this.pendingFind = null;
    this.pageLoading = false;
    this.matchesLoading = false;
    this.matches = null;
  }
}
