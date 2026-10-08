// Draws the lettered callouts on the screenshots of the user manual.
//
//   node scripts/annotate-screenshots.mjs
//
// Reads the plain screenshots in docs/images/raw and writes the annotated ones to docs/images.
// Each mark is a letter in an orange disc at (x, y), in pixels of the raw picture; `box` adds
// an outline around an area, [left, top, width, height]. The letters match the first column
// of the tables in README.md, so change both together. After retaking a screenshot, put the
// new picture in docs/images/raw and adjust its marks here.
//
// Uses sharp, which is installed as a dependency of transformers.js.

import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const RAW = new URL('../docs/images/raw/', import.meta.url);
const OUT = new URL('../docs/images/', import.meta.url);
const COLOUR = '#e8590c';
const R = 9;

/** @type {Record<string, { l: string, x: number, y: number, box?: number[] }[]>} */
const MARKS = {
  'overview.png': [
    { l: 'A', x: 181, y: 49, box: [11, 49, 341, 404] },
    { l: 'B', x: 566, y: 93, box: [361, 93, 410, 360] },
    { l: 'C', x: 566, y: 49, box: [361, 49, 410, 36] },
    { l: 'D', x: 522, y: 24 },
    { l: 'E', x: 776, y: 40 },
  ],
  'phone-text.png': [
    { l: 'D', x: 171, y: 120 },
    { l: 'E', x: 225, y: 157 },
    { l: 'F', x: 162, y: 181 },
  ],
  'phone-audio.png': [
    { l: 'D', x: 175, y: 120 },
    { l: 'E', x: 215, y: 157 },
    { l: 'F', x: 162, y: 181 },
  ],
  'step1-transcript.png': [
    { l: 'A', x: 300, y: 36 },
    { l: 'B', x: 60, y: 211 },
    { l: 'C', x: 151, y: 211 },
  ],
  'step2-check.png': [
    { l: 'A', x: 488, y: 108 },
    { l: 'B', x: 244, y: 144 },
    { l: 'C', x: 581, y: 168 },
    { l: 'D', x: 260, y: 250 },
    { l: 'E', x: 151, y: 283 },
    { l: 'F', x: 143, y: 324 },
    { l: 'G', x: 290, y: 341 },
    { l: 'H', x: 483, y: 355 },
    { l: 'I', x: 15, y: 388 },
    { l: 'J', x: 486, y: 388 },
  ],
  'step3-found.png': [
    { l: 'A', x: 309, y: 62 },
    { l: 'B', x: 158, y: 213 },
    { l: 'C', x: 104, y: 295 },
    { l: 'D', x: 312, y: 178 },
    { l: 'E', x: 312, y: 322 },
    { l: 'F', x: 302, y: 340 },
  ],
  'step4-language.png': [
    { l: 'A', x: 327, y: 63 },
    { l: 'B', x: 572, y: 79 },
    { l: 'C', x: 391, y: 178 },
    { l: 'D', x: 205, y: 229 },
  ],
  'step5-voices.png': [
    { l: 'A', x: 358, y: 108 },
    { l: 'B', x: 358, y: 150 },
    { l: 'C', x: 358, y: 192 },
    { l: 'D', x: 312, y: 243 },
    { l: 'E', x: 312, y: 276 },
    { l: 'F', x: 149, y: 315 },
  ],
  'step6-settings.png': [
    { l: 'A', x: 408, y: 133 },
    { l: 'B', x: 644, y: 149 },
    { l: 'C', x: 261, y: 177 },
    { l: 'D', x: 550, y: 193 },
    { l: 'E', x: 298, y: 238 },
    { l: 'F', x: 698, y: 315 },
    { l: 'G', x: 462, y: 404 },
    { l: 'H', x: 143, y: 451 },
    { l: 'H', x: 637, y: 404 },
    { l: 'I', x: 707, y: 537 },
    { l: 'J', x: 276, y: 567 },
    { l: 'K', x: 626, y: 582 },
    { l: 'L', x: 383, y: 628 },
    { l: 'M', x: 588, y: 715 },
  ],
  'step6-file-presets.png': [
    { l: 'A', x: 432, y: 231 },
    { l: 'B', x: 242, y: 366 },
    { l: 'B', x: 521, y: 366 },
    { l: 'C', x: 362, y: 405 },
    { l: 'D', x: 442, y: 405 },
  ],
  'step7-render-progress.png': [
    { l: 'A', x: 155, y: 66 },
    { l: 'B', x: 239, y: 66 },
    { l: 'C', x: 723, y: 111 },
    { l: 'D', x: 342, y: 156 },
  ],
  'step7-render.png': [
    { l: 'A', x: 292, y: 67 },
    { l: 'B', x: 461, y: 67 },
    { l: 'B', x: 631, y: 67 },
    { l: 'C', x: 189, y: 118 },
    { l: 'D', x: 360, y: 136 },
    { l: 'E', x: 468, y: 136 },
    { l: 'F', x: 223, y: 173 },
    { l: 'G', x: 723, y: 194 },
  ],
  'translate-card.png': [
    { l: 'A', x: 152, y: 112 },
    { l: 'B', x: 281, y: 113 },
    { l: 'C', x: 394, y: 128 },
    { l: 'D', x: 343, y: 160 },
    { l: 'E', x: 187, y: 193 },
  ],
  'translate-review.png': [
    { l: 'A', x: 84, y: 97 },
    { l: 'B', x: 456, y: 97 },
    { l: 'C', x: 174, y: 497 },
    { l: 'D', x: 253, y: 513 },
  ],
  'footer.png': [
    { l: 'A', x: 140, y: 14 },
    { l: 'B', x: 405, y: 34 },
    { l: 'C', x: 544, y: 60 },
    { l: 'D', x: 510, y: 150 },
  ],
};

for (const [name, marks] of Object.entries(MARKS)) {
  const raw = readFileSync(new URL(name, RAW));
  const { width, height } = await sharp(raw).metadata();
  const shapes = marks.map(({ l, x, y, box }) => {
    const outline = box
      ? `<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" rx="8" fill="none" stroke="${COLOUR}" stroke-width="2" stroke-dasharray="6 3"/>`
      : '';
    return `${outline}<circle cx="${x}" cy="${y}" r="${R}" fill="${COLOUR}" stroke="#fff" stroke-width="1.5"/>
      <text x="${x}" y="${y + 4}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="#fff">${l}</text>`;
  });
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`);
  await sharp(raw).composite([{ input: overlay }]).png({ compressionLevel: 9 }).toFile(new URL(name, OUT).pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('%20', ' '));
  console.log(`${name}: ${marks.length} marks`);
}
