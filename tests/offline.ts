/**
 * The service worker, which no other check can reach.
 *
 * Node cannot run one: there is no Cache API, no `self`, no fetch event. And a
 * service worker is the single worst place in a web app for a quiet mistake,
 * because a wrong one installs itself on people's devices and keeps serving the
 * wrong thing after the mistake is fixed.
 *
 * So two different things are checked here, neither of which needs a browser.
 *
 * First, the decisions, read out of the source as text. Whether install calls
 * skipWaiting is not a style question — it decides whether a new build can
 * replace the code underneath a conversion that is already running. Whether
 * blob: URLs fall through decides whether every download this app makes gets
 * copied into a cache. These are the lines someone will one day "tidy up".
 *
 * Second, the built worker against the built site. dist/sw.js carries a literal
 * list of every file to keep offline, and a list that has drifted from the
 * files beside it is invisible: the app installs, reports success, and is
 * missing a chunk that only matters once there is no signal. Comparing the two
 * is cheap and catches it before anyone finds out on a train.
 *
 * The first version of this shipped `__BUILD_ID__` and `__PRECACHE__` verbatim
 * into dist/sw.js. The build printed a summary line and exited zero.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SW_SOURCE = path.join(ROOT, 'src', 'service-worker.js');
const SW_BUILT = path.join(ROOT, 'dist', 'sw.js');
const DIST = path.join(ROOT, 'dist');
const UPDATES = path.join(ROOT, 'src', 'platform', 'updates.svelte.ts');

/**
 * Comments removed, so a check for a call is not satisfied by a mention of it.
 *
 * Learned immediately: the install handler carries the line "No skipWaiting()
 * here", which is precisely the promise being checked, and a plain text search
 * read it as the violation.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** The body of one `self.addEventListener('name', ...)` block, as text. */
function handler(source: string, name: string): string {
  const start = source.indexOf(`self.addEventListener('${name}'`);
  if (start < 0) return '';
  const next = source.indexOf('self.addEventListener(', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

/** The body of one top-level `async function name(...)`, as text. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

export async function runOfflineChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  console.log('\n=== ใช้งานออฟไลน์ (service worker) ===');

  if (!fs.existsSync(SW_SOURCE)) {
    check('มีไฟล์ src/service-worker.js', false);
    return failures;
  }
  const source = fs.readFileSync(SW_SOURCE, 'utf-8');
  // Behaviour is read off the code; the exact-match check further down uses
  // the raw file, comments and all.
  const body = code(source);

  // The one that costs a person their work: a worker that activates itself
  // swaps the app's code while a conversion is running.
  check(
    'ติดตั้งเงียบ ๆ ไม่แย่งสลับเวอร์ชันเอง (install ไม่เรียก skipWaiting)',
    !handler(body, 'install').includes('skipWaiting'),
  );
  check(
    'สลับได้เมื่อผู้ใช้สั่ง (message → skipWaiting)',
    handler(body, 'message').includes('skipWaiting'),
  );

  // blob: URLs carry the page's own origin, so an origin check alone lets every
  // preview and every download fall into the cache.
  const fetchHandler = handler(body, 'fetch');
  check(
    'ปล่อย blob:/data: ผ่าน ไม่เอาไปแคช',
    fetchHandler.includes("url.protocol !== 'https:'") &&
      fetchHandler.includes("url.protocol !== 'http:'"),
  );
  check('ไม่ยุ่งกับคำขอข้ามโดเมน', fetchHandler.includes('url.origin !== self.location.origin'));
  check('ไม่ยุ่งกับคำขอที่ไม่ใช่ GET', fetchHandler.includes("request.method !== 'GET'"));

  check(
    'ลบแคชของ build เก่าตอน activate — ที่เก็บไม่บวมไปเรื่อย ๆ',
    /caches\.delete/.test(handler(body, 'activate')),
  );

  // The direction each strategy runs in, read off the order of the calls.
  // index.html is the only unhashed file shipped; cache-first on it is how an
  // app pins itself to an old build forever.
  const shell = fn(body, 'shell');
  const asset = fn(body, 'asset');
  const before = (body: string, a: string, b: string) => {
    const ia = body.indexOf(a);
    const ib = body.indexOf(b);
    return ia >= 0 && ib >= 0 && ia < ib;
  };
  check('index.html เอาเน็ตก่อน — เปิดตอนออนไลน์ได้ของใหม่เสมอ',
    before(shell, 'await fetch(', 'cache.match('), shell ? '' : 'ไม่พบฟังก์ชัน shell');
  check('assets/* เอาแคชก่อน — ชื่อไฟล์มีแฮชอยู่แล้ว ไม่ต้องถามซ้ำ',
    before(asset, 'cache.match(', 'await fetch('), asset ? '' : 'ไม่พบฟังก์ชัน asset');

  // Found by pulling the plug, not by reading the code. Vite marks the module
  // script and the stylesheet crossorigin, so the browser asks for those two
  // with an Origin header; the precached copies were fetched without one; and
  // static hosts answer with "Vary: Origin". Both stored files then fail to
  // match the request that wants them. Online it is invisible — the miss falls
  // through to the network. Offline it is a blank page under a correct title.
  const lookups = [...body.matchAll(/cache\.match\(/g)].length;
  const ignoring = [...body.matchAll(/cache\.match\([^)]*, MATCH\)/g)].length;
  check('อ่านแคชโดยข้าม Vary ทุกจุด — ไม่งั้นออฟไลน์ได้จอขาว',
    lookups > 0 && lookups === ignoring, `${ignoring} จาก ${lookups} จุด`);

  // --- the registration side -------------------------------------------------

  const updates = code(fs.readFileSync(UPDATES, 'utf-8'));
  check('ไม่ register ตอน dev — กัน bundle เมื่อวานทับงานวันนี้',
    updates.includes('import.meta.env.DEV') && updates.includes('unregister()'));
  check('ไม่ register ในไฟล์เดี่ยว/file://',
    updates.includes('__HAS_SW__') && updates.includes("location.protocol.startsWith('http')"));
  // controllerchange also fires on the very first install. Reloading then would
  // restart a page nobody asked to restart.
  check('reload เฉพาะตอนผู้ใช้กดเอง',
    /controllerchange[\s\S]{0,120}this\.applying/.test(updates));

  // --- the built worker, against the built site --------------------------------

  if (!fs.existsSync(SW_BUILT)) {
    console.log('  SKIP  ตรวจ dist/sw.js — ยังไม่ได้ build (รัน `npm run build` ก่อน แล้วรันเทสต์ใหม่)');
    return failures;
  }
  const built = fs.readFileSync(SW_BUILT, 'utf-8');

  const idLine = /^const BUILD_ID = '[0-9a-f]{12}';$/m.exec(built)?.[0];
  const listLine = /^const PRECACHE = \[[\s\S]*?\n\];$/m.exec(built)?.[0];
  check('dist/sw.js เติม BUILD_ID จริง ไม่ใช่ placeholder', idLine !== undefined,
    /__BUILD_ID__/.test(built) ? 'ยังเป็น __BUILD_ID__' : '');
  check('dist/sw.js เติมรายการไฟล์จริง ไม่ใช่ placeholder', listLine !== undefined,
    /__PRECACHE__/.test(built) ? 'ยังเป็น __PRECACHE__' : '');
  if (!idLine || !listLine) return failures;

  // Exact, not approximate: dist/sw.js must be this source with those two
  // declarations swapped and nothing else. Catches a stale dist as surely as a
  // failed substitution.
  const expected = source
    .replace(/const BUILD_ID = '__BUILD_ID__';/, () => idLine)
    .replace(/const PRECACHE = __PRECACHE__;/, () => listLine);
  check('dist/sw.js สร้างจาก src/service-worker.js ตัวปัจจุบัน (ต่างแค่ 2 บรรทัดที่ build เติม)',
    expected === built,
    expected === built ? '' : 'ต่างกันเกิน 2 บรรทัด — dist เก่าค้าง หรือ build ไม่ตรง source');

  let precache: string[];
  try {
    precache = JSON.parse(listLine.replace(/^const PRECACHE = /, '').replace(/;$/, ''));
  } catch (e) {
    check('อ่านรายการไฟล์ออฟไลน์ได้', false, String((e as Error).message));
    return failures;
  }

  // Everything that was shipped, as the worker would name it.
  const shipped: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else shipped.push('./' + path.relative(DIST, full).split(path.sep).join('/'));
    }
  };
  walk(DIST);

  const listed = new Set(precache);
  const missing = shipped.filter((f) => f !== './sw.js' && !listed.has(f));
  const phantom = precache.filter((f) => !shipped.includes(f));

  check(`ทุกไฟล์ที่ ship อยู่ในรายการออฟไลน์ (${precache.length} ไฟล์)`,
    missing.length === 0, missing.join(' '));
  check('ทุกไฟล์ในรายการมีอยู่จริงใน dist — ไม่มีชื่อค้างจาก build เก่า',
    phantom.length === 0, phantom.join(' '));
  // Caching the worker inside its own cache is how an app refuses to update.
  check('ไม่เอา sw.js ใส่แคชของตัวเอง', !listed.has('./sw.js'));

  // The manifest is the one file that names other files by hand, so it is the
  // one that can point at something the build never produced.
  const manifestPath = path.join(DIST, 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    const icons = (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).icons ?? []) as {
      src: string;
    }[];
    const offlineIcons = icons.filter((i) => !listed.has('./' + i.src.replace(/^\.\//, '')));
    check('ไอคอนทุกใบใน manifest ใช้ได้ตอนออฟไลน์',
      offlineIcons.length === 0, offlineIcons.map((i) => i.src).join(' '));
  }

  const bytes = precache.reduce(
    (sum, rel) => sum + fs.statSync(path.join(DIST, rel.replace(/^\.\//, ''))).size,
    0,
  );
  console.log(`  ขนาดที่เก็บลงเครื่องครั้งแรก: ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  return failures;
}
