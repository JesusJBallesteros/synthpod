// Development aid: print how pdf.js sees a PDF (lines with position and font size per page),
// to tune the extraction rules in src/parse/pdf.ts.  Usage: node scripts/pdf-dump.mjs file.pdf [pages]
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const [file, maxPages = '3'] = process.argv.slice(2);
const doc = await getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true }).promise;
console.log(`pages: ${doc.numPages}`);
for (let p = 1; p <= Math.min(doc.numPages, Number(maxPages)); p++) {
  const page = await doc.getPage(p);
  const { width, height } = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  console.log(`\n=== page ${p} (${Math.round(width)}x${Math.round(height)}), ${items.length} items`);
  const lines = new Map();
  for (const it of items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10;
    const key = y;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ x: Math.round(it.transform[4]), size, str: it.str });
  }
  for (const [y, parts] of [...lines].sort((a, b) => b[0] - a[0])) {
    parts.sort((a, b) => a.x - b.x);
    const sizes = [...new Set(parts.map((q) => q.size))].join('/');
    console.log(`y=${String(y).padStart(4)} x=${String(parts[0].x).padStart(4)} sz=${sizes.padEnd(9)} | ${parts.map((q) => q.str).join('').slice(0, 110)}`);
  }
}
