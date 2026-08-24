/**
 * Page range parsing, shared by every tool that takes one.
 *
 * Its own module rather than living on the registry, because both the registry
 * (for predictions) and the engines (for the real work) need it, and having the
 * engine import the registry would close a cycle.
 */

export interface RangeResult {
  /** 0-based page indices, deduplicated and ordered. */
  pages: number[];
  /** Ranges the user typed that fall outside the document. */
  outOfBounds: string[];
  /** True when the text had something in it but nothing parsed. */
  unparsable: boolean;
}

/**
 * Parses "1-5, 8, 11-" against a page count.
 *
 * Reports what it could not use rather than silently dropping it: a typo in a
 * range is the difference between the pages someone wanted and the pages they
 * got, and finding that out after the download is too late.
 */
export function parseRangeSpec(spec: string, pageCount: number): RangeResult {
  const pages: number[] = [];
  const outOfBounds: string[] = [];
  let sawChunk = false;
  let parsedAny = false;

  for (const chunk of spec.split(/[,\s]+/)) {
    if (!chunk) continue;
    sawChunk = true;

    const m = /^(\d+)?(?:(-)(\d+)?)?$/.exec(chunk);
    if (!m || (!m[1] && !m[2])) {
      outOfBounds.push(chunk);
      continue;
    }

    const open = m[2] === '-';
    const from = m[1] ? parseInt(m[1], 10) : 1;
    const to = open ? (m[3] ? parseInt(m[3], 10) : pageCount) : from;

    if (from < 1 || from > pageCount || to < from) {
      outOfBounds.push(chunk);
      continue;
    }

    parsedAny = true;
    // A range that overshoots the end is clamped rather than rejected — "11-"
    // on a nine-page file plainly means "to the end".
    for (let p = from; p <= Math.min(to, pageCount); p++) pages.push(p - 1);
    if (to > pageCount) outOfBounds.push(chunk);
  }

  return {
    pages: [...new Set(pages)].sort((a, b) => a - b),
    outOfBounds,
    unparsable: sawChunk && !parsedAny,
  };
}

/** Just the indices, for callers that only want the happy path. */
export function parseRanges(spec: string, pageCount: number): number[] {
  return parseRangeSpec(spec, pageCount).pages;
}

/** [0,1,2,5,6,9] -> "1-3, 6-7, 10" — for showing back what was understood. */
export function describeRanges(pages: number[]): string {
  if (pages.length === 0) return '';
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== prev + 1) {
      parts.push(start === prev ? String(start + 1) : `${start + 1}-${prev + 1}`);
      start = cur;
    }
    prev = cur;
  }
  return parts.join(', ');
}

/**
 * Same spec, but each comma-separated chunk kept as its own group.
 *
 * Split needs "1-5, 6-12" to mean two files, where Merge needs it to mean one
 * set of pages. Flattening first and regrouping later cannot recover the
 * boundaries, so the boundaries are kept from the start.
 */
export function parseRangeGroups(spec: string, pageCount: number): { groups: number[][]; outOfBounds: string[] } {
  const groups: number[][] = [];
  const outOfBounds: string[] = [];

  for (const chunk of spec.split(',')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parsed = parseRangeSpec(trimmed, pageCount);
    outOfBounds.push(...parsed.outOfBounds);
    if (parsed.pages.length > 0) groups.push(parsed.pages);
  }

  return { groups, outOfBounds };
}
