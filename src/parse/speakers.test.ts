import { describe, expect, it } from 'vitest';
import { subtitlesToText } from './input';
import { parseTranscript, type Turn } from './parse';
import { applyEdits, guessHost, speakerStats, suggestAssignment, suggestMerges, type Edits } from './speakers';

const noEdits = (): Edits => ({ renames: new Map(), assignments: new Map() });

describe('speaker edits', () => {
  const turns: Turn[] = [
    { speaker: null, text: 'It was the strangest week of my whole career, honestly.' },
    { speaker: 'Anna Weber', text: 'Welcome. What happened?' },
    { speaker: 'Ben', text: 'Well. It was the strangest week of my whole career, honestly. Then it got worse.' },
    { speaker: 'Weber', text: 'And then?' },
  ];

  it('suggests merging a surname or initials into the full name', () => {
    expect(suggestMerges(['Anna Weber', 'Ben', 'Weber', 'AW'])).toEqual([
      { from: 'Weber', into: 'Anna Weber' },
      { from: 'AW', into: 'Anna Weber' },
    ]);
  });

  it('suggests the speaker of a cold-open teaser', () => {
    expect(suggestAssignment(turns, turns[0])).toBe('Ben');
  });

  it('applies renames, merges and assignments', () => {
    const edits = noEdits();
    edits.renames.set('Weber', 'Anna Weber');
    edits.renames.set('Ben', 'Benjamin');
    const out = applyEdits(turns, edits);
    expect(out.map((t) => t.speaker)).toEqual(['Benjamin', 'Anna Weber', 'Benjamin', 'Anna Weber']);
    edits.assignments.set(turns[0].text, '');
    expect(applyEdits(turns, edits)[0].speaker).toBeNull();
  });

  it('computes shares and guesses the host', () => {
    const out = applyEdits(turns, { ...noEdits(), renames: new Map([['Weber', 'Anna Weber']]) });
    const stats = speakerStats(out);
    expect(stats.map((s) => s.name)).toEqual(['Ben', 'Anna Weber']);
    expect(stats.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
    expect(guessHost(out)).toBe('Anna Weber');
  });
});

describe('subtitlesToText', () => {
  it('reads SRT cues and joins them into turns', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nAnna: Hello\n\n2\n00:00:03,000 --> 00:00:05,000\nthere, everyone.\n\n3\n00:00:05,500 --> 00:00:07,000\nBen: Hi.\n\n4\n00:00:08,000 --> 00:00:09,000\nAnna: Bye.\n\n5\n00:00:09,000 --> 00:00:10,000\nBen: Bye.';
    const r = parseTranscript(subtitlesToText(srt));
    expect(r.turns[0]).toEqual({ speaker: 'Anna', text: 'Hello there, everyone.' });
    expect(r.turns).toHaveLength(4);
  });

  it('reads WebVTT with a header, notes, identifiers and voice tags', () => {
    const vtt = 'WEBVTT\n\nNOTE made by hand\nsecond note line\n\nintro\n00:01.000 --> 00:03.000\n<v Anna>Hello <i>there</i>.</v>\n\n00:03.000 --> 00:05.000 align:start\n<v Ben>Hi.</v>\n\n00:05.000 --> 00:06.000\n<v Anna>Bye.</v>\n\n00:06.000 --> 00:07.000\n<v Ben>Bye.</v>';
    const r = parseTranscript(subtitlesToText(vtt));
    expect(r.speakers).toEqual(['Anna', 'Ben']);
    expect(r.turns[0].text).toBe('Hello there.');
  });
});
