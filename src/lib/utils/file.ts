export const MAX_BYTES = 20 * 1024 * 1024;

export interface FileCheck { ok: boolean; error?: string }

export function checkPdfFile(file: File): FileCheck {
  const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!looksPdf) return { ok: false, error: 'กรุณาเลือกไฟล์ PDF' };
  if (file.size > MAX_BYTES) return { ok: false, error: 'ไฟล์ใหญ่เกินไป กรุณาเลือก PDF ขนาดไม่เกิน 20 MB' };
  if (file.size === 0) return { ok: false, error: 'ไฟล์ว่างเปล่า' };
  return { ok: true };
}

/** Receipt-2988.pdf -> Receipt-2988-edited.pdf */
export function createOutputName(filename: string): string {
  return /\.pdf$/i.test(filename) ? filename.replace(/\.pdf$/i, '-edited.pdf') : filename + '-edited.pdf';
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
