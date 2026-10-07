import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Cross-origin isolation lets the WASM engines use several threads.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/** Emit dist/sw.js from src/pwa/sw.js with the list of files to keep for offline use. */
function serviceWorker(): Plugin {
  return {
    name: 'synthpod-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      // The WebGPU runtime is only referenced, never loaded from here (Kokoro fetches its own).
      const files = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', ...Object.keys(bundle).filter((f) => !f.includes('.jsep'))];
      const id = createHash('sha256').update(JSON.stringify(files)).update(String(Date.now())).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./src/pwa/sw.js', import.meta.url), 'utf8')
        .replace('__BUILD_ID__', id)
        .replace('__PRECACHE_FILES__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Some static hosts do not know the ".mjs" extension and serve such files as a download, which
// browsers refuse to run. The speech runtime ships as .mjs, so it is published as .js instead.
const output = {
  assetFileNames: (asset: { names?: string[] }) => (asset.names?.[0]?.endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]'),
};

export default defineConfig({
  base: './',
  build: { rollupOptions: { output } },
  worker: { format: 'es', rollupOptions: { output } },
  server: { headers: isolation },
  preview: { headers: isolation },
  plugins: [serviceWorker()],
});
