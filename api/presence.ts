/**
 * How many people have this open right now.
 *
 * This is the one endpoint this app has, and it exists under a headline that
 * tells people nothing is uploaded — so what it does and does not carry is not
 * a detail, it is the whole point:
 *
 *   · it never sees a document. No file, no filename, no page count, nothing
 *     derived from one. The browser does the work; this only counts browsers.
 *   · what it stores is one random number per open tab and the second it last
 *     checked in, and that pair evaporates 45 seconds after the tab stops
 *     asking. There is no cookie, no account, no visit history, nothing that
 *     survives closing the tab.
 *   · the caller's IP and user agent arrive with the request, as they do with
 *     every request on the web, and are read by nothing here and written
 *     nowhere. Nothing is logged.
 *
 * A sorted set does the whole job: score is the timestamp, member is the tab's
 * id. Drop everything older than the window, add yourself, count what is left.
 * Nobody has to be told when they leave — a tab that stops checking in ages out
 * on its own, which is the only behaviour that survives a closed laptop.
 */
export const config = { runtime: 'edge' };

/** How long a tab counts as present after its last check-in. */
const WINDOW_MS = 45_000;

/** A tab id is 32 hex characters and nothing else. Anything else is dropped. */
const ID = /^[0-9a-f]{32}$/;

interface Env {
  url: string;
  token: string;
}

/**
 * Vercel's KV integration and a plain Upstash database set different names for
 * the same two values, and which one you get depends on how the store was
 * added. Accept both rather than make that a thing anybody has to remember.
 */
function credentials(): Env | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A count that is one second old is not the count. Nothing between here
      // and the tab may keep a copy.
      'cache-control': 'no-store',
    },
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);

  const creds = credentials();
  // No store wired up yet. Say so plainly and let the page hide the badge:
  // a made-up number would be worse than no number, on this page especially.
  if (!creds) return json({ error: 'not-configured' }, 503);

  const raw = new URL(request.url).searchParams.get('id') ?? '';
  const id = ID.test(raw) ? raw : null;

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // One round trip. Joining is optional: a caller with no id just reads the
  // count, which is what a second tab of the same page should do.
  const commands: (string | number)[][] = [['ZREMRANGEBYSCORE', 'presence', '-inf', cutoff]];
  if (id) commands.push(['ZADD', 'presence', now, id]);
  commands.push(['ZCARD', 'presence']);
  // Nothing keeps the key alive but the tabs in it, so let it expire on its own
  // if everyone goes home. Without this it would live forever holding zero.
  commands.push(['EXPIRE', 'presence', 300]);

  let replies: { result?: unknown; error?: string }[];
  try {
    const response = await fetch(`${creds.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!response.ok) return json({ error: 'store-unavailable' }, 502);
    replies = (await response.json()) as typeof replies;
  } catch {
    return json({ error: 'store-unreachable' }, 502);
  }

  const card = replies[id ? 2 : 1];
  const online = typeof card?.result === 'number' ? card.result : Number(card?.result);
  if (!Number.isFinite(online)) return json({ error: 'store-unavailable' }, 502);

  return json({ online, windowMs: WINDOW_MS });
}
