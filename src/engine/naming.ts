/**
 * Output filenames.
 *
 * Small, but every tool needs it and every tool would get a different corner
 * wrong: doubling an extension, losing a Thai name to a regex that assumed
 * ASCII, or numbering split files so they sort wrongly in a file manager.
 */

/** report.pdf -> report */
export function stem(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '');
}

/** Ensures exactly one .pdf on the end, whatever the caller typed. */
export function asPdfName(name: string): string {
  const trimmed = name.trim().replace(/\.pdf$/i, '');
  return (trimmed || 'document') + '.pdf';
}

/**
 * Fills a split-style pattern.
 *
 * The counter is padded to the width of the largest number so that 2 sorts
 * before 10 in a file manager, which is where these actually get looked at.
 */
export function fillPattern(
  pattern: string,
  values: { name: string; n: number; total: number },
): string {
  const width = String(values.total).length;
  return pattern
    .replace(/<name>/g, values.name)
    .replace(/<nn>/g, String(values.n).padStart(width, '0'))
    .replace(/<n>/g, String(values.n));
}

/** Windows and macOS both refuse some of these; a download that cannot be saved is not a result. */
export function sanitiseFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}
