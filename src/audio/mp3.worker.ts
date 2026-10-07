/// <reference lib="webworker" />
import { Mp3Encoder } from '@breezystack/lamejs';
import { ID3Writer } from 'browser-id3-writer';
import { chapterFrames, insertFrames, type Chapter } from './captions';
import { buildInfoFrame, effectiveBitrate } from './xing';

export interface Mp3Tags {
  title: string;
  artist: string;
  year: string;
  comment: string;
  chapters: Chapter[];
}

export interface Mp3Request {
  pcm: Float32Array; // mono
  sampleRate: number;
  kbps: number;
  stereo: boolean;
  tags: Mp3Tags;
}

export type Mp3Response = { type: 'progress'; fraction: number } | { type: 'done'; file: ArrayBuffer };

const BLOCK = 1152 * 32;

function addTags(file: Uint8Array, tags: Mp3Tags): ArrayBuffer {
  const writer = new ID3Writer(file.buffer as ArrayBuffer);
  if (tags.title) writer.setFrame('TIT2', tags.title);
  if (tags.artist) writer.setFrame('TPE1', [tags.artist]);
  if (/^\d{4}$/.test(tags.year)) writer.setFrame('TYER', Number(tags.year));
  if (tags.comment) writer.setFrame('COMM', { description: '', text: tags.comment, language: 'eng' });
  // The tag library has no chapter support, so those frames are added to its output.
  return insertFrames(writer.addTag(), chapterFrames(tags.chapters));
}

self.onmessage = (e: MessageEvent<Mp3Request>) => {
  const { pcm, sampleRate, stereo, tags } = e.data;
  const enc = new Mp3Encoder(stereo ? 2 : 1, sampleRate, effectiveBitrate(sampleRate, e.data.kbps));
  const parts: Uint8Array[] = [];
  const block = new Int16Array(BLOCK);
  // Encode in blocks so a long recording never needs a second full-size sample buffer.
  for (let off = 0; off < pcm.length; off += BLOCK) {
    const n = Math.min(BLOCK, pcm.length - off);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, pcm[off + i]));
      block[i] = v < 0 ? v * 32768 : v * 32767;
    }
    const samples = block.subarray(0, n);
    // The speech is mono; "stereo" carries the same signal on both channels for players that need it.
    const out = stereo ? enc.encodeBuffer(samples, samples) : enc.encodeBuffer(samples);
    if (out.length) parts.push(new Uint8Array(out));
    self.postMessage({ type: 'progress', fraction: (off + n) / pcm.length } satisfies Mp3Response);
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));

  const audio = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    audio.set(p, offset);
    offset += p.length;
  }
  // An Info frame in front lets players show the exact duration.
  const info = buildInfoFrame(audio) ?? new Uint8Array(0);
  const file = new Uint8Array(info.length + audio.length);
  file.set(info);
  file.set(audio, info.length);
  const tagged = addTags(file, tags);
  self.postMessage({ type: 'done', file: tagged } satisfies Mp3Response, { transfer: [tagged] });
};
