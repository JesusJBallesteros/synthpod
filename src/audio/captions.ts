// Captions and chapter markers, built from the real timings of the assembled audio.

/** One spoken sentence and when it is heard, in seconds. */
export interface Cue {
  start: number;
  end: number;
  /** Index of the turn it belongs to. */
  turn: number;
  speaker: string | null;
  text: string;
  /** The section heading of this turn, in text without speakers. */
  title?: string;
}

export interface Chapter {
  title: string;
  startMs: number;
  endMs: number;
}

function clock(seconds: number, separator: string): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

/** SubRip: the speaker's name is written in front of the first line of each turn. */
export function toSrt(cues: Cue[]): string {
  return cues
    .map((cue, i) => {
      const firstOfTurn = cue.speaker && cues[i - 1]?.turn !== cue.turn;
      return `${i + 1}\n${clock(cue.start, ',')} --> ${clock(cue.end, ',')}\n${firstOfTurn ? `${cue.speaker}: ` : ''}${cue.text}\n`;
    })
    .join('\n');
}

/** WebVTT, with the speaker in a voice tag on every cue. */
export function toVtt(cues: Cue[]): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = cues.map((cue) => {
    const text = cue.speaker ? `<v ${cue.speaker.replace(/[<>\n]/g, ' ')}>${escape(cue.text)}` : escape(cue.text);
    return `${clock(cue.start, '.')} --> ${clock(cue.end, '.')}\n${text}\n`;
  });
  return `WEBVTT\n\n${body.join('\n')}`;
}

const MAX_CHAPTERS = 255; // an ID3 table of contents holds its entry count in one byte

/**
 * One chapter per turn, titled "Speaker: first words…", or with the section heading for text
 * without speakers. Long transcripts are grouped to fit the limit.
 */
export function toChapters(cues: Cue[]): Chapter[] {
  const byTurn: Cue[][] = [];
  for (const cue of cues) {
    const last = byTurn[byTurn.length - 1];
    if (last && last[0].turn === cue.turn) last.push(cue);
    else byTurn.push([cue]);
  }
  const perChapter = Math.ceil(byTurn.length / MAX_CHAPTERS);
  const chapters: Chapter[] = [];
  for (let i = 0; i < byTurn.length; i += perChapter) {
    const group = byTurn.slice(i, i + perChapter).flat();
    const words = group.map((c) => c.text).join(' ');
    const opening = words.length > 60 ? `${words.slice(0, 60).replace(/\s+\S*$/, '')}…` : words;
    chapters.push({
      title: group[0].title ?? (group[0].speaker ? `${group[0].speaker}: ${opening}` : opening),
      startMs: Math.round(group[0].start * 1000),
      endMs: Math.round(group[group.length - 1].end * 1000),
    });
  }
  // Chapters must tile the timeline: each one runs until the next begins.
  chapters.forEach((c, i) => {
    if (chapters[i + 1]) c.endMs = chapters[i + 1].startMs;
  });
  return chapters;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

/** An ID3v2.3 frame: id, size, two flag bytes, body. */
function frame(id: string, body: Uint8Array): Uint8Array {
  return concat([ascii(id), uint32(body.length), new Uint8Array(2), body]);
}

function titleFrame(text: string): Uint8Array {
  const utf16 = new Uint8Array(2 + text.length * 2);
  utf16.set([0xff, 0xfe]); // byte-order mark, little endian
  for (let i = 0; i < text.length; i++) new DataView(utf16.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true);
  return frame('TIT2', concat([Uint8Array.of(1), utf16]));
}

/** CHAP frames plus the CTOC table of contents that lists them (ID3v2 Chapter Frame Addendum). */
export function chapterFrames(chapters: Chapter[]): Uint8Array {
  if (!chapters.length) return new Uint8Array(0);
  const ids = chapters.map((_, i) => `ch${i}`);
  const noOffset = Uint8Array.of(0xff, 0xff, 0xff, 0xff);
  const chaps = chapters.map((c, i) =>
    frame('CHAP', concat([ascii(`${ids[i]}\0`), uint32(c.startMs), uint32(c.endMs), noOffset, noOffset, titleFrame(c.title)])),
  );
  // Flags 3: this is the top-level table and its entries are in order.
  const toc = frame('CTOC', concat([ascii('toc\0'), Uint8Array.of(3, ids.length), ...ids.map((id) => ascii(`${id}\0`))]));
  return concat([toc, ...chaps]);
}

/** Add frames to an existing ID3v2 tag at the start of a file, updating the tag's size. */
export function insertFrames(file: ArrayBuffer, frames: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(file);
  if (!frames.length || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return file;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const grown = size + frames.length;
  const out = concat([bytes.subarray(0, 10), frames, bytes.subarray(10)]);
  // The size is "syncsafe": seven bits per byte.
  out.set([(grown >> 21) & 0x7f, (grown >> 14) & 0x7f, (grown >> 7) & 0x7f, grown & 0x7f], 6);
  return out.buffer as ArrayBuffer;
}
