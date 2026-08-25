/**
 * Offline: the whole app, kept on the device.
 *
 * Plain JavaScript, not TypeScript, and not imported by anything. A service
 * worker runs in a global that has no `window` and no `document`, and typing it
 * properly needs `lib: WebWorker`, which contradicts the DOM lib the rest of
 * the app is checked against. Rather than fight two tsconfigs over one small
 * file, this stays hand-written and the invariants that matter are asserted
 * from tests/pwa.ts, which reads this source as text.
 *
 * The two placeholder constants below are filled in at build time by the plugin
 * in vite.config.ts. In this file, as checked into the repo, they are still
 * placeholders — this is a template, not a shippable worker, and the copy the
 * browser sees is written to dist/sw.js.
 *
 * The plugin matches whole declaration lines, and fails the build if either
 * match count is not exactly one. Reformat those two lines and the build stops;
 * that is deliberate, and much better than what happened the first time, which
 * was a green build that shipped the placeholders verbatim.
 *
 * The strategy, and why each half is what it is:
 *
 *   assets/*  are cache-first, because their names contain a hash of their
 *     contents. A file at that URL can never change, so revalidating it is
 *     spending a network round trip to be told what we already knew.
 *
 *   index.html is network-first, because its name has no hash. Cache-first on
 *     the one unhashed file is how an app gets permanently stuck on an old
 *     build: the shell in the cache keeps pointing at the assets in the cache,
 *     and nothing ever asks the server whether there is something newer.
 *
 * The cache name carries the build id, so a new build lands in a new cache and
 * the old one is deleted on activate. Nothing is ever partially replaced.
 */

const BUILD_ID = '__BUILD_ID__';
const CACHE = `simple-pdf-${BUILD_ID}`;
const PRECACHE = __PRECACHE__;

/**
 * The shell, under one canonical key. A navigation can arrive as "/", as
 * "/index.html", or as "/#/t/merge", and all three want the same document —
 * so the document is stored once, under this name, and looked up by it.
 */
const INDEX = './index.html';

/**
 * Every lookup ignores Vary, and it is not an optimisation.
 *
 * Vite marks the module script and the stylesheet `crossorigin`, so the browser
 * asks for those two in CORS mode, with an Origin header. The copies here were
 * fetched by the worker during install, with no Origin header at all. Hosts
 * answer static files with `Vary: Origin` — Vercel does, `vite preview` does —
 * and by the rules that makes the stored copy a non-match for the request the
 * page actually makes. Two cache misses, both for files sitting right there.
 *
 * Online nobody would ever see it: a miss falls through to the network and the
 * page loads. Offline it is the whole app. The observed symptom was a correct
 * title over a blank page, with the JS and the CSS both ERR_FAILED and both
 * present in the cache.
 *
 * Ignoring Vary is safe here because every URL in this cache has exactly one
 * representation: the names are content hashes, and index.html is stored once.
 */
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll is all-or-nothing on purpose: if one file 404s, install fails,
      // this worker never activates, and whatever was already installed keeps
      // serving. A half-filled cache would be worse than no update at all.
      cache.addAll(PRECACHE),
    ),
  );
  // No skipWaiting() here. A new worker taking over mid-run would swap the code
  // under a conversion that is already in flight. It waits until the person
  // says so — see the message handler at the bottom.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('simple-pdf-') && key !== CACHE) await caches.delete(key);
      }
      // Take over the page that registered us, so the first visit is already
      // offline-capable instead of needing a reload to become one.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // blob: URLs share the page's origin, and this app makes a lot of them —
  // every preview and every download. They must fall straight through: caching
  // one would pin a dead handle, and an origin check alone would not catch it.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(request.mode === 'navigate' ? shell(request) : asset(request));
});

/** Network first, so an online visit always sees the current build. */
async function shell(request) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(INDEX, fresh.clone());
    }
    return fresh;
  } catch {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(INDEX, MATCH);
    if (cached) return cached;
    throw new Error('offline and no cached shell');
  }
}

/** Cache first, because everything reaching here was precached by hash. */
async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;

  const fresh = await fetch(request);
  // Only a real same-origin success is worth keeping. An opaque response or a
  // 404 stored here would be handed out for the whole life of the build.
  if (fresh.ok && fresh.type === 'basic') await cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
