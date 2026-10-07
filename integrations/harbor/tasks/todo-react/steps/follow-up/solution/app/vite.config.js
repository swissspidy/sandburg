import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The Express API (server/index.js).
    proxy: { '/api': 'http://localhost:3001' },
  },
});
