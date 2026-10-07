import { Mp3Encoder } from '@breezystack/lamejs';
import { ID3Writer } from 'browser-id3-writer';
import { parseBuffer } from 'music-metadata';
import { describe, expect, it } from 'vitest';
import { chapterFrames, insertFrames } from './captions';
import { buildInfoFrame } from './xing';

/** Build a file the way mp3.worker.ts does: audio, Info frame, ID3 tag, chapter frames. */
function buildFile(seconds: number, rate: number): Uint8Array {
  const enc = new Mp3Encoder(1, rate, 64);
  const samples = Int16Array.from({ length: seconds * rate }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate) * 8000);
  const parts = [enc.encodeBuffer(samples), enc.flush()];
  const audio = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    audio.set(p, offset);
    offset += p.length;
  }
  const info = buildInfoFrame(audio)!;
  const file = new Uint8Array(info.length + audio.length);
  file.set(info);
  file.set(audio, info.length);
  const writer = new ID3Writer(file.buffer as ArrayBuffer);
  writer.setFrame('TIT2', 'City Hives').setFrame('TPE1', ['Maya Ortiz, Daniel Kim']);
  const chapters = [
    { title: 'Maya Ortiz: Welcome back…', startMs: 0, endMs: 4000 },
    { title: 'Daniel Kim: Thanks, Maya. Señor Ñandú…', startMs: 4000, endMs: 10000 },
  ];
  return new Uint8Array(insertFrames(writer.addTag(), chapterFrames(chapters)));
}

describe('the finished MP3, read back by an independent parser', () => {
  it('has the tags, the right duration and the chapter markers', async () => {
    const metadata = await parseBuffer(buildFile(10, 22050), { mimeType: 'audio/mpeg' }, { includeChapters: true, duration: false });
    expect(metadata.common.title).toBe('City Hives');
    expect(metadata.common.artist).toBe('Maya Ortiz, Daniel Kim');
    // The duration comes from the Info frame; without it the parser would have to guess.
    expect(metadata.format.duration).toBeGreaterThan(9.9);
    expect(metadata.format.duration).toBeLessThan(10.2);
    const chapters = metadata.format.chapters ?? [];
    expect(chapters.map((c) => c.title)).toEqual(['Maya Ortiz: Welcome back…', 'Daniel Kim: Thanks, Maya. Señor Ñandú…']);
  });
});
