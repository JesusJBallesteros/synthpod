// Serves dist/ the way GitHub Pages does: plain static files under a sub-path, with no special
// headers. Use it to check the service worker, offline mode and the automatic first-visit reload,
// which `vite preview` hides because it sends the cross-origin isolation headers itself.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const base = '/synthpod/';
const port = 4180;
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith(base)) {
    res.writeHead(pathname === '/' ? 302 : 404, { Location: base }).end();
    return;
  }
  const file = join(root, normalize(decodeURIComponent(pathname.slice(base.length)) || 'index.html'));
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Serving dist/ at http://localhost:${port}${base}`));
