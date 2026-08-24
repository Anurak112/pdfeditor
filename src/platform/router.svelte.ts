/**
 * Hash routing, deliberately.
 *
 * The build target is still a single .html file you can double-click, and
 * history routing needs a server that rewrites unknown paths. A hash works
 * identically from a dev server, a static host and file:// — so the shipped
 * artefact and the dev build cannot disagree about navigation.
 */
export type Route =
  | { name: 'home' }
  | { name: 'tool'; toolId: string }
  /** The standalone text editor, kept reachable while it moves into the shell. */
  | { name: 'legacy' };

function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0];
  if (path === 'legacy') return { name: 'legacy' };
  const tool = /^t\/([a-z-]+)$/.exec(path);
  if (tool) return { name: 'tool', toolId: tool[1] };
  return { name: 'home' };
}

class Router {
  route = $state<Route>(parse(location.hash));

  constructor() {
    addEventListener('hashchange', () => {
      this.route = parse(location.hash);
    });
  }

  go(to: Route) {
    const hash = to.name === 'home' ? '#/' : to.name === 'legacy' ? '#/legacy' : `#/t/${to.toolId}`;
    if (location.hash === hash) {
      // Same hash fires no hashchange, so nudge the state directly.
      this.route = to;
      return;
    }
    location.hash = hash;
  }

  home() {
    this.go({ name: 'home' });
  }

  openTool(toolId: string) {
    this.go({ name: 'tool', toolId });
  }
}

export const router = new Router();
