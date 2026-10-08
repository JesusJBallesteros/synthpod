import { describe, expect, it } from 'vitest';
import { rebuildTurns, route, targetsFor, toTranscript } from '../translate/pairs';
import { chapterFrames, insertFrames, toChapters, toCueSheet, toSrt, toVtt, type Cue } from './captions';

const cues: Cue[] = [
  { start: 0, end: 1.5, turn: 0, speaker: null, text: 'A teaser.' },
  { start: 2, end: 3.25, turn: 1, speaker: 'Anna', text: 'Hello <there>.' },
  { start: 3.4, end: 5, turn: 1, speaker: 'Anna', text: 'How are you?' },
  { start: 3605.5, end: 3607.007, turn: 2, speaker: 'Ben', text: 'Fine.' },
];

describe('captions', () => {
  it('writes SubRip with the speaker on the first line of each turn', () => {
    expect(toSrt(cues)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nA teaser.\n\n' +
        '2\n00:00:02,000 --> 00:00:03,250\nAnna: Hello <there>.\n\n' +
        '3\n00:00:03,400 --> 00:00:05,000\nHow are you?\n\n' +
        '4\n01:00:05,500 --> 01:00:07,007\nBen: Fine.\n',
    );
  });

  it('writes WebVTT with voice tags and escaped text', () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nA teaser.\n')).toBe(true);
    expect(vtt).toContain('00:00:02.000 --> 00:00:03.250\n<v Anna>Hello &lt;there&gt;.\n');
  });
});

describe('chapters', () => {
  it('makes one chapter per turn that runs until the next begins', () => {
    expect(toChapters(cues)).toEqual([
      { title: 'A teaser.', startMs: 0, endMs: 2000 },
      { title: 'Anna: Hello <there>. How are you?', startMs: 2000, endMs: 3605500 },
      { title: 'Ben: Fine.', startMs: 3605500, endMs: 3607007 },
    ]);
  });

  it('names a chapter after its section heading when there is one', () => {
    const sections: Cue[] = [
      { start: 0, end: 2, turn: 0, speaker: null, text: 'Front matter.' },
      { start: 3, end: 4, turn: 1, speaker: null, text: 'Methods.', title: 'Methods' },
      { start: 4.2, end: 9, turn: 1, speaker: null, text: 'We did this and that.', title: 'Methods' },
    ];
    expect(toChapters(sections).map((c) => c.title)).toEqual(['Front matter.', 'Methods']);
  });

  it('groups turns when there are more than a table of contents can hold', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ start: i, end: i + 0.5, turn: i, speaker: 'A', text: `Line ${i}.` }));
    const chapters = toChapters(many);
    expect(chapters.length).toBeLessThanOrEqual(255);
    expect(chapters[0].startMs).toBe(0);
    expect(chapters.at(-1)!.endMs).toBe(599500);
  });

  it('writes CTOC and CHAP frames and grows the tag to hold them', () => {
    const frames = chapterFrames(toChapters(cues));
    const text = new TextDecoder('latin1').decode(frames);
    expect(text.startsWith('CTOC')).toBe(true);
    expect(text.match(/CHAP/g)).toHaveLength(3);
    // First CHAP: element id "ch0", then start and end in milliseconds.
    const at = text.indexOf('CHAP') + 10;
    expect(text.slice(at, at + 4)).toBe('ch0\0');
    const view = new DataView(frames.buffer, frames.byteOffset);
    expect(view.getUint32(at + 4)).toBe(0);
    expect(view.getUint32(at + 8)).toBe(2000);
    // Each frame's declared size must walk exactly to the end of the block.
    let offset = 0;
    while (offset < frames.length) offset += 10 + view.getUint32(offset + 4);
    expect(offset).toBe(frames.length);

    // A minimal tag: "ID3", version 2.3, no flags, 20 bytes of content, then audio.
    const file = new Uint8Array(10 + 20 + 4);
    file.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]);
    file.set([0xff, 0xfb, 0x90, 0x00], 30);
    const out = new Uint8Array(insertFrames(file.buffer, frames));
    const size = (out[6] << 21) | (out[7] << 14) | (out[8] << 7) | out[9];
    expect(size).toBe(20 + frames.length);
    expect([...out.subarray(10 + size, 10 + size + 2)]).toEqual([0xff, 0xfb]);
    expect(insertFrames(new Uint8Array([1, 2, 3]).buffer, frames).byteLength).toBe(3); // no tag: untouched
  });
});

describe('cue sheet', () => {
  it('lists the chapters with their positions in minutes, seconds and frames', () => {
    const sheet = toCueSheet(
      [
        { title: 'Introducción', startMs: 0, endMs: 101733 },
        { title: 'She said "no"', startMs: 101733, endMs: 3605500 },
        { title: 'The end', startMs: 3605500, endMs: 3700000 },
      ],
      { file: 'My paper.mp3', title: 'My paper', performer: '' },
    );
    expect(sheet).toBe(
      '\uFEFFTITLE "My paper"\r\nFILE "My paper.mp3" MP3\r\n' +
        '  TRACK 01 AUDIO\r\n    TITLE "Introducción"\r\n    INDEX 01 00:00:00\r\n' +
        "  TRACK 02 AUDIO\r\n    TITLE \"She said 'no'\"\r\n    INDEX 01 01:41:55\r\n" +
        '  TRACK 03 AUDIO\r\n    TITLE "The end"\r\n    INDEX 01 60:05:38\r\n',
    );
  });

  it('never lists more than 99 tracks', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ title: `Part ${i}`, startMs: i * 1000, endMs: (i + 1) * 1000 }));
    const sheet = toCueSheet(many, { file: 'a.mp3', title: 'a', performer: 'Someone' });
    expect(sheet.match(/TRACK \d+ AUDIO/g)!.length).toBeLessThanOrEqual(99);
    expect(sheet).toContain('PERFORMER "Someone"');
  });
});

describe('translation routing', () => {
  it('uses a direct model when there is one, else goes through English', () => {
    expect(route('en', 'es')).toEqual(['Xenova/opus-mt-en-es']);
    expect(route('de', 'it')).toEqual(['Xenova/opus-mt-de-en', 'Xenova/opus-mt-en-it']);
    expect(route('en', 'en')).toBeNull();
    expect(route('en', 'ja')).toBeNull(); // only the ja→en direction exists
    expect(targetsFor('es').slice(0, 5)).toEqual(['de', 'en', 'fr', 'it', 'ru']);
    expect(targetsFor('xx')).toEqual([]);
  });

  it('rebuilds a labelled transcript from translated sentences', () => {
    const units = [
      { turn: 0, paragraph: 0, text: 'A teaser.' },
      { turn: 1, paragraph: 0, text: 'Hello.' },
      { turn: 1, paragraph: 0, text: 'How are you?' },
      { turn: 1, paragraph: 1, text: 'New paragraph.' },
      { turn: 2, paragraph: 0, text: 'Fine.' },
    ];
    const translated = ['Un avance.', 'Hola.', '¿Cómo estás?', 'Párrafo nuevo.', 'Bien.'];
    const texts = rebuildTurns(3, units, translated);
    expect(texts).toEqual(['Un avance.', 'Hola. ¿Cómo estás?\n\nPárrafo nuevo.', 'Bien.']);
    expect(toTranscript([null, null], ['Título.\n\nCuerpo.', 'Suelto.'], [true, false])).toBe('## Título.\n\nCuerpo.\n\nSuelto.');
    expect(toTranscript([null, 'Anna', 'Ben'], texts)).toBe('Un avance.\n\nAnna: Hola. ¿Cómo estás?\n\nPárrafo nuevo.\n\nBen: Bien.');
  });
});
