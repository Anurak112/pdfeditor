/**
 * The manifest, and whether it is telling the truth.
 *
 * A web app manifest is the one file nothing checks. The type checker has never
 * heard of it, the build copies it verbatim, and a browser that dislikes it
 * declines to install the app without saying so anywhere a developer will look.
 * Rename an icon and the only symptom is that the install option quietly stops
 * appearing.
 *
 * So the icons are opened and measured rather than trusted: a PNG that says
 * 512x512 in the manifest has to actually be 512x512 in its own header. That is
 * the mistake this catches — declaring one size and shipping another — which no
 * amount of "the file exists" would notice.
 */
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const INDEX = path.join(import.meta.dirname, '..', 'index.html');

interface ManifestIcon {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
}

/** Width and height straight out of the PNG header, not out of the filename. */
function pngSize(file: string): { width: number; height: number } | null {
  const bytes = fs.readFileSync(file);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => bytes[i] === b)) return null;
  // IHDR is always the first chunk: 8 signature + 4 length + 4 type, then w, h.
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export async function runPwaChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  console.log('\n=== ติดตั้งลงหน้าจอ (manifest) ===');

  const manifestPath = path.join(PUBLIC, 'manifest.webmanifest');
  if (!fs.existsSync(manifestPath)) {
    check('มีไฟล์ manifest', false, manifestPath);
    return failures;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    check('manifest เป็น JSON ที่อ่านได้', false, String((e as Error).message));
    return failures;
  }
  check('manifest เป็น JSON ที่อ่านได้', true);

  // The fields a browser needs before it will offer to install anything.
  for (const field of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    check(`มี ${field}`, manifest[field] !== undefined);
  }
  check('display เป็น standalone', manifest.display === 'standalone', String(manifest.display));
  check('start_url สัมพัทธ์ — วางใต้ path ย่อยได้',
    typeof manifest.start_url === 'string' && manifest.start_url.startsWith('.'),
    String(manifest.start_url));

  const icons = (manifest.icons ?? []) as ManifestIcon[];
  check('มีไอคอนอย่างน้อย 192 และ 512',
    icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512'),
    icons.map((i) => i.sizes).join(' '));

  // Android crops icons to whatever shape the launcher uses; without a maskable
  // one it crops the square and takes the corners off the artwork.
  check('มีไอคอนแบบ maskable สำหรับ Android',
    icons.some((i) => i.purpose === 'maskable'),
    icons.map((i) => i.purpose ?? 'any').join(' '));

  for (const icon of icons) {
    const file = path.join(PUBLIC, icon.src.replace(/^\.\//, ''));
    if (!fs.existsSync(file)) {
      check(`ไอคอน ${icon.src} มีอยู่จริง`, false, 'ไม่พบไฟล์');
      continue;
    }
    if (!icon.src.endsWith('.png')) {
      check(`ไอคอน ${icon.src} มีอยู่จริง`, true);
      continue;
    }
    const size = pngSize(file);
    const [w, h] = icon.sizes.split('x').map(Number);
    check(`ไอคอน ${icon.src} ขนาดตรงกับที่ประกาศ`,
      size !== null && size.width === w && size.height === h,
      size ? `${size.width}x${size.height} vs ${icon.sizes}` : 'ไม่ใช่ PNG');
  }

  // iOS ignores the manifest's icons entirely and uses this one.
  const apple = path.join(PUBLIC, 'apple-touch-icon.png');
  const appleSize = fs.existsSync(apple) ? pngSize(apple) : null;
  check('มี apple-touch-icon ให้ iOS (iOS ไม่อ่าน icons ใน manifest)',
    appleSize !== null && appleSize.width === 180,
    appleSize ? `${appleSize.width}x${appleSize.height}` : 'ไม่มี');

  const html = fs.readFileSync(INDEX, 'utf-8');
  check('index.html ลิงก์ manifest ไว้', /<link[^>]+rel="manifest"/.test(html));
  check('index.html ลิงก์ apple-touch-icon ไว้', /rel="apple-touch-icon"/.test(html));
  check('มี theme-color ทั้งโหมดสว่างและมืด',
    /theme-color[^>]+prefers-color-scheme: light/.test(html) &&
      /theme-color[^>]+prefers-color-scheme: dark/.test(html));

  return failures;
}
