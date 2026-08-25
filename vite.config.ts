import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

// so a running app can say which build it is — the question "is this the latest
// one?" should be answerable by looking at the screen, not by checking files
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/**
 * Writes dist/sw.js from src/service-worker.js, with the list of files to keep
 * offline filled in.
 *
 * The list comes from walking the finished dist/ rather than from reading the
 * bundle, and that is the point: public/ has already been copied by the time
 * this runs, so icons and the manifest are covered by the same mechanism as the
 * hashed chunks. A list assembled from the bundle would have missed them, and
 * nothing would have said so — the app would simply have shown a broken icon
 * the first time someone opened it with no signal.
 *
 * The build id is a hash of every shipped file's contents, so it changes when
 * and only when something shipped changed. That makes sw.js itself byte-
 * different on a real change, which is what makes the browser notice there is
 * an update at all.
 *
 * It names the site, not the worker: sw.js is left out of its own hash, so
 * editing only the worker leaves the id alone. That is correct rather than a
 * gap — the id names a set of cached files, and those files did not change. The
 * browser still updates, because it compares the worker's bytes, not this.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();

  return {
    name: 'simple-pdf-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          // sw.js is kept out of its own precache list: handing the browser a
          // cached copy of the worker it is trying to replace is how an app
          // gets stuck, and it would make the build id depend on the file the
          // build id is written into.
          else if (entry !== 'sw.js' && !entry.endsWith('.map')) found.push(full);
        }
      };
      walk(outDir);

      const list = found.map((f) => path.relative(outDir, f).split(path.sep).join('/')).sort();

      const digest = createHash('sha256');
      for (const rel of list) {
        digest.update(rel);
        digest.update(readFileSync(path.join(outDir, rel)));
      }

      // Anchored to the declaration, not to the bare name. String.replace takes
      // the first match, and the first match was the mention of the name in the
      // file's own header comment — so the real placeholders shipped untouched
      // and the build said nothing. Hence also the count check below: a
      // substitution that silently does not happen is worse than a failed build.
      const substitutions: [RegExp, string][] = [
        [/const BUILD_ID = '__BUILD_ID__';/, `const BUILD_ID = '${digest.digest('hex').slice(0, 12)}';`],
        [
          /const PRECACHE = __PRECACHE__;/,
          'const PRECACHE = ' + JSON.stringify(list.map((rel) => './' + rel), null, 2) + ';',
        ],
      ];

      let source = readFileSync(path.join(root, 'src', 'service-worker.js'), 'utf-8');
      for (const [pattern, replacement] of substitutions) {
        const hits = source.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
        if (hits !== 1) {
          this.error(`service worker: ${pattern.source} matched ${hits} times, expected 1`);
        }
        // Function form, so a "$" anywhere in a filename is a "$" and not a
        // back-reference into the match.
        source = source.replace(pattern, () => replacement);
      }

      writeFileSync(path.join(outDir, 'sw.js'), source);

      const bytes = list.reduce((sum, rel) => sum + statSync(path.join(outDir, rel)).size, 0);
      this.info(
        'sw.js — ' + list.length + ' files, ' + (bytes / 1024 / 1024).toFixed(1) + ' MB offline',
      );
    },
  };
}

// mode "singlefile"  -> one self-contained .html you can double-click (offline, no server)
// default build      -> normal dist/ for `npm run preview` or hosting
export default defineConfig(({ mode }) => {
  const single = mode === 'singlefile';
  return {
    base: './',
    plugins: [
      svelte(),
      ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : [serviceWorker()]),
    ],
    worker: { format: 'es' },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
      // The single file is already the whole app in one document: there is no
      // sw.js beside it to register, and it is opened from file:// anyway.
      __HAS_SW__: JSON.stringify(!single),
    },
    build: {
      target: 'es2022',
      outDir: single ? 'dist-single' : 'dist',
      assetsInlineLimit: single ? 1024 * 1024 * 8 : 4096,
      chunkSizeWarningLimit: 4000,
    },
    server: { port: 5183, open: true },
  };
});
