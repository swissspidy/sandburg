import { defineConfig } from 'vite';
import { solidStart } from '@solidjs/start/config';

export default defineConfig({
  plugins: [solidStart()],
  // SolidStart 2.0.5's dev overlay imports @jridgewell/trace-mapping, whose resolve-uri dependency is
  // a UMD file: served unbundled, it fails to load in the browser (also on Node). Pre-bundle it.
  // SolidStart's transform adds the import of its server-function client, which Vite's dependency scan
  // misses: found when a route with a server function loads, it is pre-bundled late. From 2.2.0, which
  // pre-bundles trace-mapping too, that rebundles the trace-mapping named below and Vite reloads the
  // page, which can lose a server function's call (also on Node). Pre-bundle it with the rest.
  optimizeDeps: { include: ['@jridgewell/trace-mapping', '@jridgewell/resolve-uri', '@solidjs/start/fns/client'] },
});
