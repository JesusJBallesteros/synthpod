// Development aid: print what an independent parser finds in an MP3 made by the app
// (tags, duration, chapters), plus the raw ID3 frames.  Usage: node scripts/mp3-info.mjs file.mp3
import { readFileSync } from 'node:fs';
import { parseBuffer } from 'music-metadata';

const data = new Uint8Array(readFileSync(process.argv[2]));
const size = ((data[6] & 127) << 21) | ((data[7] & 127) << 14) | ((data[8] & 127) << 7) | (data[9] & 127);
console.log(`ID3v2.${data[3]}.${data[4]}, flags ${data[5]}, tag size ${size}`);
const view = new DataView(data.buffer, data.byteOffset);
const frames = {};
for (let off = 10; off < 10 + size && data[off] !== 0; ) {
  const id = String.fromCharCode(...data.subarray(off, off + 4));
  frames[id] = (frames[id] ?? 0) + 1;
  off += 10 + view.getUint32(off + 4);
}
console.log('frames:', frames);

const meta = await parseBuffer(data, { mimeType: 'audio/mpeg' }, { includeChapters: true, duration: false });
console.log('title:', meta.common.title, '| artist:', meta.common.artist);
console.log('duration:', meta.format.duration?.toFixed(1), 's | bitrate:', meta.format.bitrate, '| sample rate:', meta.format.sampleRate);
const chapters = meta.format.chapters ?? [];
console.log(`chapters: ${chapters.length}`);
for (const c of chapters) console.log('  ', JSON.stringify(c).slice(0, 160));
