import { defineConfig } from 'vite';
import { solidStart } from '@solidjs/start/config';

export default defineConfig({
  plugins: [solidStart()],
  // SolidStart 2.0.5's dev overlay imports @jridgewell/trace-mapping, whose resolve-uri dependency is
  // a UMD file: served unbundled, it fails to load in the browser (also on Node). Pre-bundle it.
  // The client of server functions is first imported when one is called. Found then, it is pre-bundled
  // late, and since 2.2.0 (it imports more) Vite reloads the page for it as the call starts, which can
  // lose the call (also on Node). Pre-bundle it with the rest.
  optimizeDeps: { include: ['@jridgewell/trace-mapping', '@jridgewell/resolve-uri', '@solidjs/start/fns/client'] },
});
