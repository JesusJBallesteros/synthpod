import { describe, expect, it } from 'vitest';
import { parseTranscript } from './parse';

describe('parseTranscript: basic formats', () => {
  it('detects inline labels', () => {
    const r = parseTranscript('Anna: Hello there.\nBen: Hi Anna.\nANNA: How are you?\nBen: Fine.');
    expect(r.format).toBe('inline');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
    expect(r.turns).toHaveLength(4);
    expect(r.turns[0].text).toBe('Hello there.');
  });

  it('detects own-line labels and joins wrapped lines', () => {
    const r = parseTranscript('ANNA:\nHello\nthere.\n\nSecond paragraph.\nBEN:\nHi.\nANNA:\nBye.\nBEN:\nBye.');
    expect(r.format).toBe('ownline');
    expect(r.turns[0].text).toBe('Hello there.\n\nSecond paragraph.');
    expect(r.turns).toHaveLength(4);
  });

  it('marks text before the first label as unassigned', () => {
    const r = parseTranscript('Teaser line.\nAnna: One.\nBen: Two.\nAnna: Three.\nBen: Four.');
    expect(r.turns[0].speaker).toBeNull();
  });

  it('ignores labels that occur only once', () => {
    const r = parseTranscript('Anna: See this.\nNote: it matters.\nBen: ok\nAnna: yes\nBen: fine');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
    expect(r.turns[0].text).toBe('See this. Note: it matters.');
  });

  it('falls back to a single unassigned turn', () => {
    const r = parseTranscript('Just some prose with no speakers.\nNote: still prose.');
    expect(r.format).toBe('none');
    expect(r.turns).toEqual([{ speaker: null, text: 'Just some prose with no speakers. Note: still prose.' }]);
  });

  it('accepts two speakers who each speak once', () => {
    const r = parseTranscript('Anna: A long monologue.\nBen: And a long answer.');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
  });

  it('does not take times or web addresses for labels', () => {
    const r = parseTranscript('Anna: Meet at\n12:30 sharp.\nBen: See https://example.org\nhttps://example.org\nAnna: ok\nBen: ok');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
  });
});

describe('parseTranscript: other label patterns', () => {
  it('reads markdown-bold labels', () => {
    const r = parseTranscript('**Anna:** Hello.\n**Ben:** Hi.\n**Anna:** Bye.\n**Ben:** Bye.');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
    expect(r.turns[0].text).toBe('Hello.');
  });

  it('reads bracketed labels', () => {
    const r = parseTranscript('[Anna] Hello.\n[Ben] Hi.\n[Anna] Bye.\n[Ben] Bye.');
    expect(r.format).toBe('bracket');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
  });

  it('reads dash labels', () => {
    const r = parseTranscript('Anna — Hello.\nBen — Hi.\nAnna — Bye.\nBen — Bye.');
    expect(r.format).toBe('dash');
    expect(r.turns[1]).toEqual({ speaker: 'Ben', text: 'Hi.' });
  });

  it('reads timecode + label, with and without brackets', () => {
    const r = parseTranscript('[00:12:03] Anna: Hello.\n00:12:09 Ben: Hi.\n[00:12:15] Anna: Bye.\n00:12:20 Ben: Bye.');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
    expect(r.turns.map((t) => t.text)).toEqual(['Hello.', 'Hi.', 'Bye.', 'Bye.']);
  });

  it('reads the f4/f5 format with the timecode at the end', () => {
    const r = parseTranscript('I: Wie geht es? #00:00:05-2#\nB: Gut, danke. #00:00:09-8#\nI: Schön. #00:00:12-0#\nB: Ja. #00:00:13-1#');
    expect(r.speakers).toEqual(['I', 'B']);
    expect(r.turns[1].text).toBe('Gut, danke.');
  });

  it('reads interview initials with dots', () => {
    const r = parseTranscript('Int.: Frage eins?\nBefr.: Antwort.\nInt.: Frage zwei?\nBefr.: Antwort.');
    expect(r.speakers).toEqual(['Int.', 'Befr.']);
  });

  it('reads WebVTT voice tags', () => {
    const r = parseTranscript('<v Anna>Hello there.</v>\n<v Ben>Hi.</v>\n<v Anna>Bye.</v>\n<v Ben>Bye.</v>');
    expect(r.speakers).toEqual(['Anna', 'Ben']);
    expect(r.turns[0].text).toBe('Hello there.');
  });
});

describe('parseTranscript: names and clean-up', () => {
  it('treats titles, case and parenthetical suffixes as the same speaker', () => {
    const r = parseTranscript('ANNA WEBER (COLD OPEN): Teaser.\nProf. Dr. Anna Weber: Hello.\nBen: Hi.\nanna weber: Bye.\nBen: Bye.');
    expect(r.speakers).toEqual(['ANNA WEBER', 'Ben']);
    expect(r.turns.filter((t) => t.speaker === 'ANNA WEBER')).toHaveLength(3);
  });

  it('keeps a one-off short form of a speaker name so it can be merged', () => {
    const r = parseTranscript('Anna Weber: Hello.\nBen: Hi.\nWeber: And then?\nBen: Bye.\nAnna Weber: Bye.\nNote: not a speaker.');
    expect(r.speakers).toEqual(['Anna Weber', 'Ben', 'Weber']);
  });

  it('strips stage directions but keeps ordinary parentheses', () => {
    const r = parseTranscript('Anna: Well (laughs) that was [inaudible] fun (and true).\nBen: Yes (lacht).\nAnna: ok\nBen: ok');
    expect(r.turns[0].text).toBe('Well that was fun (and true).');
    expect(r.turns[1].text).toBe('Yes.');
  });

  it('keeps directions and timecodes when the toggles are off', () => {
    const r = parseTranscript('Anna: Hi (laughs). #00:00:05-2#\nBen: Yo.\nAnna: ok\nBen: ok', { stripDirections: false, stripTimecodes: false });
    expect(r.turns[0].text).toBe('Hi (laughs). #00:00:05-2#');
  });

  it('keeps only the expected number of speakers', () => {
    const text = 'Anna: a\nBen: b\nAnna: c\nBen: d\nAnna: e\nCaller: f\nCaller: g';
    expect(parseTranscript(text).speakers).toEqual(['Anna', 'Ben', 'Caller']);
    expect(parseTranscript(text, { expectedSpeakers: 2 }).speakers).toEqual(['Anna', 'Ben']);
  });

  it('honours a format hint', () => {
    const r = parseTranscript('ANNA:\nSee this: it works.\nBEN:\nSee this: fine.\nANNA:\nok\nBEN:\nok', { hint: 'ownline' });
    expect(r.speakers).toEqual(['ANNA', 'BEN']);
  });
});
