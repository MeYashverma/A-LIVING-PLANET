import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    headers: {
      // WebGL + worker friendly; avoid CSP surprises in previews.
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
});
