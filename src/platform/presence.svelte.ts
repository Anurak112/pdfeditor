/**
 * The live count of people with this open, and the rules it plays by.
 *
 * This is the only thing in the app that talks to a server, and it sits under
 * a line promising that nothing is uploaded — so it is built to keep that line
 * true rather than to explain it away:
 *
 *   · it sends one random number and nothing else. Never a file, a filename,
 *     or anything read out of one.
 *   · it stops entirely while the tab is in the background. A tab left open
 *     behind another window costs nothing and, correctly, stops counting.
 *   · when it cannot reach the server — offline, blocked, no store wired up —
 *     the count goes back to null and the badge disappears. There is no cached
 *     last-known number and no invented one. On a page that sells being
 *     checkable, a plausible fake is the one unacceptable failure mode.
 *
 * The id lives in sessionStorage, which is per-tab and dies with the tab, so a
 * refresh does not briefly count as two people while the old entry ages out.
 * When storage throws — private mode, site data blocked — an in-memory id does
 * the same job for as long as the page is open.
 */

/** Between check-ins. Comfortably inside the server's 45s window, twice over. */
const EVERY_MS = 20_000;

const ID_KEY = 'simplepdf.tab';

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function tabId(): string {
  try {
    const seen = sessionStorage.getItem(ID_KEY);
    if (seen && /^[0-9a-f]{32}$/.test(seen)) return seen;
    const fresh = newId();
    sessionStorage.setItem(ID_KEY, fresh);
    return fresh;
  } catch {
    return newId();
  }
}

class Presence {
  /** People online, or null when unknown — which is also "do not show this". */
  online = $state<number | null>(null);

  private id = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  /**
   * Called once at startup. Never throws and never blocks the page: a failure
   * here means one badge does not appear, which is not worth a broken load.
   */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.id = tabId();

    document.addEventListener('visibilitychange', () => this.sync());
    window.addEventListener('online', () => this.sync());
    window.addEventListener('offline', () => {
      this.online = null;
      this.stopTimer();
    });
    // A tab that is closing should not be counted for another 45 seconds.
    // pagehide fires where unload does not, including on iOS.
    window.addEventListener('pagehide', () => this.stopTimer());

    this.sync();
  }

  /** Runs while the tab is visible and online; idle otherwise. */
  private sync(): void {
    const active = document.visibilityState === 'visible' && navigator.onLine;
    if (!active) {
      this.stopTimer();
      return;
    }
    if (this.timer) return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), EVERY_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async ping(): Promise<void> {
    try {
      const response = await fetch(`/api/presence?id=${this.id}`, {
        cache: 'no-store',
        // Nothing to send along and nothing to receive: no cookies exist for
        // this origin and none should start existing because of this.
        credentials: 'omit',
      });
      if (!response.ok) {
        this.online = null;
        return;
      }
      const body = (await response.json()) as { online?: unknown };
      this.online = typeof body.online === 'number' && body.online > 0 ? body.online : null;
    } catch {
      // Offline, blocked by an extension, or no store configured yet.
      this.online = null;
    }
  }
}

export const presence = new Presence();
