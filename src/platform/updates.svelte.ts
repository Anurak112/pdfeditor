/**
 * Registering the offline worker, and noticing when a newer one is ready.
 *
 * The part that needs care is not the registration — it is what happens when a
 * second build arrives while someone is using the first. A service worker that
 * calls skipWaiting() on its own swaps the code out from under a page that may
 * be halfway through a conversion, and the file the person was working on goes
 * with it. So the new worker installs, then stops, and the app puts a bar on
 * screen. Nothing changes until they say so.
 *
 * That makes the reload a deliberate act, which in turn makes it safe to
 * reload the page automatically once the swap happens — the only way to reach
 * that point is to have asked for it.
 */

/** Don't pester the server on every tab focus; once an hour is plenty. */
const CHECK_INTERVAL = 60 * 60 * 1000;

class Updates {
  /** A newer build is installed and waiting. Shows the bar. */
  available = $state(false);

  /** They pressed the button; the page is on its way out. */
  applying = $state(false);

  private waiting: ServiceWorker | null = null;
  private lastCheck = 0;

  /**
   * Called once at startup. Never throws: a browser that refuses to register
   * one is a browser without offline support, which is a smaller problem than
   * a blank page.
   */
  async register(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;

    // A worker left over from `npm run preview` on the same origin would serve
    // yesterday's bundle to today's dev server, and the symptom — edits that
    // do nothing — points nowhere near the cause.
    if (import.meta.env.DEV) {
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      return;
    }

    // The single-file build has no sw.js beside it, and file:// cannot host one.
    if (!__HAS_SW__ || !location.protocol.startsWith('http')) return;

    try {
      const reg = await navigator.serviceWorker.register('./sw.js');

      // Installed during an earlier visit and still waiting.
      if (reg.waiting && navigator.serviceWorker.controller) this.offer(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          // Without a controller this is the first install, not an update:
          // there is no old version to replace and nothing to announce.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            this.offer(incoming);
          }
        });
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Also fires on the very first install, when clients.claim() takes
        // over this page. Reloading then would restart a page nobody asked to
        // restart, so the flag is the whole guard.
        if (this.applying) location.reload();
      });

      // An installed app can stay open for days without ever navigating, and
      // the browser's own update check is tied to navigation. Without this, the
      // bar below would be code that never runs.
      this.lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (Date.now() - this.lastCheck < CHECK_INTERVAL) return;
        this.lastCheck = Date.now();
        reg.update().catch(() => {
          /* offline, most likely — try again next time it comes forward */
        });
      });
    } catch {
      /* no offline support this session; the app itself is unaffected */
    }
  }

  /** Take the new version now. Reloads once the swap lands. */
  apply(): void {
    if (!this.waiting || this.applying) return;
    this.applying = true;
    this.waiting.postMessage({ type: 'skip-waiting' });

    // If the worker is gone or never answers, don't leave them looking at a
    // button that did nothing. A plain reload still picks up the new build.
    setTimeout(() => {
      if (this.applying) location.reload();
    }, 4000);
  }

  /** Not now. It will be offered again on the next visit. */
  dismiss(): void {
    this.available = false;
  }

  private offer(worker: ServiceWorker): void {
    this.waiting = worker;
    this.available = true;
  }
}

export const updates = new Updates();
