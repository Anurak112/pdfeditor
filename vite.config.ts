import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

// so a running app can say which build it is — the question "is this the latest
// one?" should be answerable by looking at the screen, not by checking files
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// mode "singlefile"  -> one self-contained .html you can double-click (offline, no server)
// default build      -> normal dist/ for `npm run preview` or hosting
export default defineConfig(({ mode }) => {
  const single = mode === 'singlefile';
  return {
    base: './',
    plugins: [svelte(), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
    worker: { format: 'es' },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
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
