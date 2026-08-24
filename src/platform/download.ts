/**
 * Handing results back to the user.
 *
 * A separate helper from the editor's own downloader because outputs here are
 * not always PDFs — images, text and ZIPs all come out of the convert and split
 * tools, and a hardcoded application/pdf type makes the browser save a .txt
 * that Windows then refuses to open with anything sensible.
 */
export function downloadBytes(bytes: Uint8Array, filename: string, mimeType = 'application/pdf') {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the save dialog to have taken the blob, short enough that a
  // batch of downloads does not pin every result in memory.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** report.pdf + '-merged' -> report-merged.pdf, keeping the extension last. */
export function suffixName(filename: string, suffix: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return filename + suffix;
  return filename.slice(0, dot) + suffix + filename.slice(dot);
}
