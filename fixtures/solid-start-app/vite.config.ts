import { defineConfig } from 'vite';
import { solidStart } from '@solidjs/start/config';

export default defineConfig({
  plugins: [solidStart()],
  // SolidStart 2.0.5's dev overlay imports @jridgewell/trace-mapping, whose resolve-uri dependency is
  // a UMD file: served unbundled, it fails to load in the browser (also on Node). Pre-bundle it.
  optimizeDeps: { include: ['@jridgewell/trace-mapping', '@jridgewell/resolve-uri'] },
});
