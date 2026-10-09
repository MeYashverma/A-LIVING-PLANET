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
    watch: {
      // Generated assets and tooling output change often (model builds, dist
      // from `vite build`). Watching them forces a full page reload on every
      // write. Static files are still served fresh without a watch.
      ignored: ['**/public/**', '**/tools/**', '**/dist/**', '**/.git/**'],
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
});
