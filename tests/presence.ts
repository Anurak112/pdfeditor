/**
 * The live count: the one endpoint this app has, and the one thing on the page
 * that could quietly start lying.
 *
 * Two things are checked, and only one of them is about counting.
 *
 * The first is the arithmetic — that a tab joins, that the number handed back
 * is the number in the store, that a caller with no id reads without joining.
 * The endpoint is an edge function, which means it is a plain function from
 * Request to Response, which means Node can run it as-is. The store behind it
 * is a `fetch` away, so a stub stands in for it and the commands sent are read
 * back and asserted on directly.
 *
 * The second matters more. This badge sits under a headline that says nothing
 * is uploaded, and the failure that would cost the most is not a wrong count —
 * it is a *plausible* one, invented locally when the server cannot be reached,
 * or a real one frozen into a cache and served for the life of the build. So
 * the responses must say no-store, the client must go back to showing nothing
 * on any failure, and the worker must let /api/ through untouched. Those are
 * read out of the source as text, the way the service worker's decisions are:
 * they are exactly the lines somebody tidies up later without knowing why they
 * were written that way.
 */
import fs from 'node:fs';
import path from 'node:path';
import handler from '../api/presence';

const SRC = path.join(import.meta.dirname, '..', 'src');

interface Sent {
  url: string;
  commands: (string | number)[][];
  auth: string | undefined;
}

/** Stands in for the store. Returns whatever count the caller asks it to. */
function stubStore(count: number | 'down'): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body ?? '[]')) as (string | number)[][];
    sent.push({
      url: String(input),
      commands,
      auth: new Headers(init?.headers).get('authorization') ?? undefined,
    });
    if (count === 'down') return new Response('nope', { status: 500 });
    // One reply per command, with ZCARD's slot carrying the count.
    const replies = commands.map((c) => ({ result: c[0] === 'ZCARD' ? count : 1 }));
    return new Response(JSON.stringify(replies), { status: 200 });
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CONFIGURED = {
  KV_REST_API_URL: 'https://store.example',
  KV_REST_API_TOKEN: 'secret-token',
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
};
const UNCONFIGURED = {
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
};

const ID = 'a'.repeat(32);

function req(query = '', method = 'GET'): Request {
  return new Request(`https://simple.pdf/api/presence${query}`, { method });
}

function names(sent: Sent | undefined): string[] {
  return (sent?.commands ?? []).map((c) => String(c[0]));
}

export async function runPresenceChecks(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  console.log('\n=== จำนวนคนออนไลน์ : ฝั่งเซิร์ฟเวอร์ ===');

  // --- no store wired up yet ------------------------------------------------
  {
    const res = await withEnv(UNCONFIGURED, () => handler(req(`?id=${ID}`)));
    const body = (await res.json()) as { error?: string; online?: number };
    check('ยังไม่ได้ต่อ store: ตอบ 503 ไม่ใช่เลขมั่ว', res.status === 503, String(res.status));
    check(
      'ยังไม่ได้ต่อ store: ไม่มีตัวเลขติดมาเลย',
      body.online === undefined && body.error === 'not-configured',
      JSON.stringify(body),
    );
  }

  // --- the count ------------------------------------------------------------
  {
    const store = stubStore(9);
    const res = await withEnv(CONFIGURED, () => handler(req(`?id=${ID}`)));
    const body = (await res.json()) as { online?: number };
    store.restore();

    check('นับได้ตรงกับที่อยู่ใน store', body.online === 9, String(body.online));
    check(
      'ยิงไปที่ store ที่ตั้งไว้ พร้อม token',
      store.sent[0]?.url === 'https://store.example/pipeline' && store.sent[0]?.auth === 'Bearer secret-token',
    );

    const cmds = names(store.sent[0]);
    check('ล้างคนที่หมดอายุก่อนนับ', cmds[0] === 'ZREMRANGEBYSCORE', cmds.join(','));
    check('เข้าร่วมด้วย id ของตัวเอง', cmds.includes('ZADD'));
    check('ตั้งวันหมดอายุให้ key — ไม่ค้างถือศูนย์ตลอดกาล', cmds.includes('EXPIRE'));

    const zadd = (store.sent[0]?.commands ?? []).find((c) => c[0] === 'ZADD');
    check('ส่งไปแค่ id สุ่มของแท็บ ไม่มีอะไรอื่น', zadd?.[3] === ID, String(zadd?.[3]));
  }

  // --- a caller with no id reads without joining ----------------------------
  {
    const store = stubStore(3);
    const res = await withEnv(CONFIGURED, () => handler(req()));
    const body = (await res.json()) as { online?: number };
    store.restore();
    const cmds = names(store.sent[0]);
    check('ไม่ส่ง id มา: อ่านอย่างเดียว ไม่นับตัวเอง', !cmds.includes('ZADD'), cmds.join(','));
    check('ไม่ส่ง id มา: ยังได้ตัวเลขกลับ', body.online === 3, String(body.online));
  }

  // --- an id that is not an id ---------------------------------------------
  {
    const store = stubStore(5);
    await withEnv(CONFIGURED, () => handler(req('?id=' + encodeURIComponent('../../etc/passwd'))));
    store.restore();
    const cmds = names(store.sent[0]);
    check('id ที่ไม่ใช่ 32 hex ไม่ถูกเขียนลง store', !cmds.includes('ZADD'), cmds.join(','));
  }

  // --- the store is down ----------------------------------------------------
  {
    const store = stubStore('down');
    const res = await withEnv(CONFIGURED, () => handler(req(`?id=${ID}`)));
    const body = (await res.json()) as { online?: number };
    store.restore();
    check(
      'store ล่ม: ไม่แต่งตัวเลขขึ้นมาแทน',
      body.online === undefined && res.status === 502,
      `${res.status} ${JSON.stringify(body)}`,
    );
  }

  // --- method ---------------------------------------------------------------
  {
    const res = await withEnv(CONFIGURED, () => handler(req(`?id=${ID}`, 'POST')));
    check('รับเฉพาะ GET', res.status === 405, String(res.status));
  }

  // --- never cached ---------------------------------------------------------
  {
    const store = stubStore(2);
    const res = await withEnv(CONFIGURED, () => handler(req(`?id=${ID}`)));
    store.restore();
    check(
      'ตอบกลับห้ามแคช (no-store)',
      res.headers.get('cache-control') === 'no-store',
      res.headers.get('cache-control') ?? 'ไม่มี header',
    );
  }

  console.log('\n=== จำนวนคนออนไลน์ : ข้อสัญญาที่อ่านจาก source ===');

  const client = fs.readFileSync(path.join(SRC, 'platform', 'presence.svelte.ts'), 'utf-8');
  const worker = fs.readFileSync(path.join(SRC, 'service-worker.js'), 'utf-8');
  const home = fs.readFileSync(path.join(SRC, 'platform', 'routes', 'Home.svelte'), 'utf-8');

  check(
    'service worker ปล่อย /api/ ผ่าน ไม่เอาไปแคช',
    worker.includes("url.pathname.startsWith('/api/')"),
    'ไม่งั้นตัวเลขแรกที่โหลดได้จะถูกแจกไปตลอดอายุ build',
  );

  check('ยิงแบบ no-store ที่ฝั่ง client ด้วย', client.includes("cache: 'no-store'"));
  check('ไม่ส่งคุกกี้ไปกับคำขอ', client.includes("credentials: 'omit'"));

  // Counting the occurrences would pass for the wrong reason the moment someone
  // adds a fourth one somewhere harmless. Each way this can fail gets named.
  const ping = client.slice(client.indexOf('private async ping'));
  check('เซิร์ฟเวอร์ตอบไม่ ok → กลับไปเป็น "ไม่รู้"', /!response\.ok\)\s*\{\s*this\.online = null/.test(ping));
  check('ยิงไม่ออกเลย (catch) → กลับไปเป็น "ไม่รู้"', /catch\s*\{[\s\S]{0,200}?this\.online = null/.test(ping));
  check('ออฟไลน์ → กลับไปเป็น "ไม่รู้"', /'offline'[\s\S]{0,160}?this\.online = null/.test(client));
  check('นับได้ 0 ก็ถือว่าไม่มีอะไรจะโชว์', /body\.online > 0 \? body\.online : null/.test(ping));
  check('ตัวนับเริ่มต้นที่ "ไม่รู้" ไม่ใช่ตัวเลขตั้งต้น', client.includes('$state<number | null>(null)'));
  check('ไม่มี Math.random ในเส้นทางตัวเลข', !client.includes('Math.random'));

  check('หน้าเว็บซ่อน badge เมื่อไม่มีตัวเลขจริง', home.includes('presence.online !== null'));
  check('หยุดยิงเมื่อแท็บไม่ได้อยู่หน้าจอ', client.includes("visibilityState === 'visible'"));
  check('หยุดยิงเมื่อออฟไลน์', client.includes('navigator.onLine'));
  check('เคารพ prefers-reduced-motion', home.includes('prefers-reduced-motion'));

  return failures;
}
